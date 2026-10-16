'use client';
import { Alert, Badge, Button, Card, Field, Input, LargeTitle, Modal, Select, Spinner, Textarea } from '@meridian/ui';
import Link from 'next/link';
import { use, useState } from 'react';
import { post, useAction, useApi, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label, money, step, toMinor } from '@/lib/format';
import { CaseBadges, SlaPill, sevTone } from '../parts';

const ESC = ['', 'Escalated', 'Escalated twice'];

/** Moves a person may make by hand, and what each needs them to say. */
const NEEDS: Record<string, { title: string; field: 'resolution' | 'reason' | 'note' | null; hint?: string }> = {
  RESOLVED: { title: 'Resolve the case', field: 'resolution', hint: 'How was it fixed? The customer is told this.' },
  REOPENED: { title: 'Reopen the case', field: 'reason', hint: 'Why is it being reopened?' },
  PENDING_CUSTOMER: { title: 'Wait for the customer', field: 'note', hint: 'What do you need from them? The SLA clock pauses while you wait.' },
  PENDING_THIRD_PARTY: { title: 'Wait for a third party', field: 'note', hint: 'Who are you waiting for?' },
  PENDING_DISPATCH: { title: 'Send for a field visit', field: 'note', hint: 'What does the technician need to know?' },
};
const kindDot: Record<string, string> = { status: 'bg-accent', interaction: 'bg-success', note: 'bg-label2', assigned: 'bg-warning', severity: 'bg-danger', created: 'bg-accent' };

export default function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const { data: c, error, loading, reload } = useApi(`/cases/${id}`);
  const meta = useApi('/cases/meta');
  const tl = useApi(`/cases/${id}/timeline`);
  const inter = useApi(`/interactions?caseId=${id}&limit=50`);
  const refresh = async () => { await Promise.all([reload(), tl.reload(), inter.reload()]); };
  const act = useAction(refresh);
  const [move, setMove] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [assignQ, setAssignQ] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const [li, setLi] = useState({ channel: 'CALL_CENTER', direction: 'OUTBOUND', subject: '', summary: '' });
  const people = useApi(can('case:write') && assignQ ? `/cases/assignees?q=${encodeURIComponent(assignQ)}` : null);
  if (error) return <Alert>{error}</Alert>;
  if (loading && !c) return <Spinner />;
  if (!c) return null;
  const next: string[] = (meta.data?.transitions?.[c.status] ?? []).filter((s: string) => s !== 'DISPATCHED' && s !== 'CLOSED_AUTO');
  const need = move ? NEEDS[move] : null;
  const submitMove = async () => { if (!move) return; const body: any = { status: move }; if (need?.field) body[need.field] = text; const r = await act.run(() => post(`/cases/${id}/status`, body)); if (r) { setMove(null); setText(''); } };
  const closed = c.status.startsWith('CLOSED');
  return (
    <>
      <LargeTitle subtitle={<span className="flex flex-wrap items-center gap-2"><Badge>{label(c.type)}</Badge><CaseBadges c={c} />{c.tier !== 'STANDARD' && <Badge tone="warning">{label(c.tier)}</Badge>}<SlaPill sla={c.sla} /></span>}>{c.number} · {c.subject}</LargeTitle>
      <p className="mb-1">{c.customerId ? <>Customer {can('customer:search') ? <Link className="text-accent" href={`/customers/${c.customerId}`}>{c.customerName}</Link> : c.customerName}</> : 'Network incident'} · opened {dt(c.createdAt)}{c.assignee && <> · assigned to <strong>{c.assignee}</strong>{c.team && ` (${c.team})`}</>}</p>
      {c.categoryPath && <p className="mb-4 text-footnote text-label2">{c.categoryPath}</p>}
      {c.escalationLevel > 0 && <Alert tone="danger">{ESC[c.escalationLevel]}: this case went past its SLA and was moved up to {label(c.priority)} priority. Supervisors have been told.</Alert>}
      {c.isMaster && <Alert tone="info">This is a network incident at <strong>{c.postalNode}</strong>: {c.childCount} customer case{c.childCount === 1 ? '' : 's'} ({c.childOpenCount} open) hang from it. Resolving it resolves them all and tells each customer.</Alert>}
      {c.masterCaseId && <Alert tone="info">This case is part of a wider network incident: <Link className="font-medium text-accent" href={`/cases/${c.masterCaseId}`}>see the master case</Link>.</Alert>}
      {act.error && <Alert>{act.error}</Alert>}
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <h2 className="mb-3 text-title3 font-semibold">History</h2>
            {c.resolution && <p className="mb-3 rounded-control bg-surface2 p-3 text-subhead"><span className="text-label2">Resolution: </span>{c.resolution}</p>}
            <ol className="space-y-3">{(tl.data?.items ?? []).map((t: any, i: number) => (
              <li key={i} className="flex gap-3 text-subhead"><span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${kindDot[t.kind] ?? 'bg-label2'}`} />
                <div className="min-w-0"><div className="break-words">{t.title}</div>{t.detail?.summary && <div className="text-footnote text-label2">{t.detail.summary}</div>}{t.detail?.note && t.kind === 'status' && <div className="text-footnote text-label2">{t.detail.note}</div>}<div className="text-caption text-label2">{t.actor} · {dt(t.at)}</div></div></li>))}</ol>
            {can('case:write') && !closed && <form className="mt-4 space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => post(`/cases/${id}/notes`, { text: note }))) setNote(''); }}>
              <Field label="Add note"><Textarea rows={3} required value={note} onChange={(e) => setNote(e.target.value)} /></Field><Button type="submit" disabled={act.busy}>Add note</Button></form>}
          </Card>
          {c.type === 'BILLING_REFUND' && c.customerId && <Refunds c={c} onChange={refresh} />}
          {c.isMaster && <IncidentCases c={c} onChange={refresh} />}
          {!c.isMaster && c.customerId && <FieldVisit c={c} onChange={refresh} />}
          <Card>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-title3 font-semibold">Interactions on this case</h2>{can('case:create') && <Button variant="plain" className="!min-h-[36px] max-lg:!min-h-tap" onClick={() => setLogOpen(!logOpen)}>{logOpen ? 'Close' : 'Log an interaction'}</Button>}</div>
            {logOpen && <form className="mb-4 grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => post('/interactions', { customerId: c.customerId, caseId: id, ...li }))) { setLogOpen(false); setLi({ ...li, subject: '', summary: '' }); } }}>
              <Field label="Channel"><Select value={li.channel} onChange={(e) => setLi({ ...li, channel: e.target.value })}>{(meta.data?.channels ?? []).map((ch: string) => <option key={ch} value={ch}>{label(ch)}</option>)}</Select></Field>
              <Field label="Direction"><Select value={li.direction} onChange={(e) => setLi({ ...li, direction: e.target.value })}><option value="OUTBOUND">We contacted the customer</option><option value="INBOUND">The customer contacted us</option></Select></Field>
              <div className="sm:col-span-2"><Field label="Subject"><Input required value={li.subject} onChange={(e) => setLi({ ...li, subject: e.target.value })} /></Field></div>
              <div className="sm:col-span-2"><Field label="What was said"><Textarea rows={3} value={li.summary} onChange={(e) => setLi({ ...li, summary: e.target.value })} /></Field></div>
              <div className="sm:col-span-2"><Button type="submit" disabled={act.busy}>Save interaction</Button></div></form>}
            {(inter.data?.items ?? []).length === 0 ? <p className="text-subhead text-label2">None yet.</p> : <ul className="space-y-2">{inter.data.items.map((i: any) => <li key={i.id} className="rounded-control bg-surface2 p-3 text-subhead">
              <div className="flex flex-wrap items-center gap-2"><Badge>{label(i.channel)}</Badge><Badge tone={i.direction === 'INBOUND' ? 'neutral' : 'success'}>{i.direction === 'INBOUND' ? 'In' : 'Out'}</Badge><span className="font-medium">{i.subject}</span></div>
              {i.summary && <div className="mt-1 text-footnote text-label2">{i.summary}</div>}<div className="text-caption text-label2">{i.agent ?? i.createdBy} · {dt(i.occurredAt)}</div></li>)}</ul>}
          </Card>
        </div>
        <div className="space-y-4 lg:self-start">
          <Card className="space-y-3">
            <h2 className="text-title3 font-semibold">Service level</h2>
            <dl className="space-y-1 text-subhead">
              <div className="flex justify-between"><dt className="text-label2">First response</dt><dd>{c.firstResponseAt ? <span className="text-success">{dt(c.firstResponseAt)}</span> : <span className={c.sla.firstResponse.state === 'BREACHED' ? 'font-medium text-danger' : ''}>due {dt(c.firstResponseDue)}</span>}</dd></div>
              <div className="flex justify-between"><dt className="text-label2">Resolution</dt><dd>{c.resolvedAt ? dt(c.resolvedAt) : `due ${dt(c.resolutionDue)}`}</dd></div>
            </dl>
            {c.sla.resolution.state !== 'NONE' && <div><div className="h-2 overflow-hidden rounded-full bg-surface2"><div className={`h-full ${c.sla.resolution.state === 'BREACHED' || c.sla.resolution.state === 'MISSED' ? 'bg-danger' : c.sla.resolution.state === 'WARNING' ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${Math.min(100, c.sla.resolution.percent)}%` }} /></div><p className="mt-1 text-caption text-label2">{c.sla.resolution.percent}% of {Math.round(c.slaResolutionMinutes / 60)} h used{c.sla.resolution.state === 'PAUSED' ? ' (paused: waiting for the customer)' : ''}</p></div>}
          </Card>
          {can('case:write') && !closed && (
            <Card className="space-y-3">
              <h2 className="text-title3 font-semibold">Move the case</h2>
              <div className="flex flex-wrap gap-2">{next.map((s) => <Button key={s} variant={s === 'RESOLVED' ? 'primary' : 'secondary'} className="!min-h-[40px]" disabled={act.busy} onClick={() => (NEEDS[s]?.field ? (setMove(s), setText('')) : void act.run(() => post(`/cases/${id}/status`, { status: s })))}>{s === 'IN_PROGRESS' ? (c.status === 'NEW' || c.status === 'REOPENED' ? 'Start work' : 'Back to work') : label(s)}</Button>)}</div>
              {c.status === 'DISPATCHED' && <p className="text-footnote text-label2">A technician is booked. The field-service system updates this case as the visit goes on.</p>}
              <Field label="Severity"><Select value={c.severity} onChange={(e) => act.run(() => post(`/cases/${id}/severity`, { severity: e.target.value }))}>{(meta.data?.severities ?? []).map((s: string) => <option key={s} value={s}>{label(s)}</option>)}</Select></Field>
              <Field label="Assign to" hint={c.assignee ? `Now ${c.assignee}` : 'Nobody yet'}>
                <Input value={assignQ} onChange={(e) => setAssignQ(e.target.value)} placeholder="Search staff…" /></Field>
              {(people.data?.items ?? []).length > 0 && <ul className="space-y-1">{people.data.items.map((p: any) => <li key={p.username}><button type="button" className="w-full rounded-control bg-surface2 px-3 py-2 text-left text-subhead" onClick={async () => { if (await act.run(() => post(`/cases/${id}/assign`, { assignee: p.username }))) setAssignQ(''); }}>{p.displayName} <span className="text-label2">· {p.username}</span></button></li>)}</ul>}
              {c.assignee && <Button variant="plain" onClick={() => act.run(() => post(`/cases/${id}/assign`, { assignee: null }))}>Unassign</Button>}
            </Card>
          )}
          {can('case:write') && closed && <Card className="space-y-3"><h2 className="text-title3 font-semibold">Closed</h2><Button variant="secondary" onClick={() => { setMove('REOPENED'); setText(''); }}>Reopen the case</Button></Card>}
          <Card className="text-subhead"><dl className="space-y-1">
            <div className="flex justify-between"><dt className="text-label2">Severity</dt><dd><Badge tone={sevTone(c.severity)}>{label(c.severity)}</Badge></dd></div>
            <div className="flex justify-between"><dt className="text-label2">Tier</dt><dd>{label(c.tier)}</dd></div>
            {c.postalNode && <div className="flex justify-between"><dt className="text-label2">Postal node</dt><dd className="font-mono">{c.postalNode}</dd></div>}
            {c.reopenCount > 0 && <div className="flex justify-between"><dt className="text-label2">Reopened</dt><dd>{c.reopenCount}×</dd></div>}
            {c.autoCloseAt && <div className="flex justify-between"><dt className="text-label2">Closes itself</dt><dd>{dt(c.autoCloseAt)}</dd></div>}
          </dl></Card>
        </div>
      </div>
      {need && <Modal onClose={() => setMove(null)} title={need.title}>
        <div className="space-y-3"><Field label={need?.field === 'resolution' ? 'Resolution' : need?.field === 'reason' ? 'Reason' : 'Note'} hint={need?.hint}><Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          {act.error && <Alert>{act.error}</Alert>}
          <div className="flex gap-2"><Button disabled={act.busy || (need?.field === 'resolution' || need?.field === 'reason' ? text.trim().length < 3 : false)} onClick={() => void submitMove()}>Confirm</Button><Button variant="secondary" onClick={() => setMove(null)}>Cancel</Button></div></div>
      </Modal>}
    </>
  );
}

/** Refunds on a billing dispute: ask, and (for someone in a high enough tier) approve or reject what others asked. */
function Refunds({ c, onChange }: { c: any; onChange: () => Promise<void> }) {
  const { can } = useAuth();
  const data = useApi(`/cases/${c.id}/refunds`);
  const pending = useApi(can('case:write') ? '/refunds/pending' : null);
  const invoices = useApi(`/invoices?customerId=${c.customerId}&limit=20`);
  const act = useAction(async () => { await Promise.all([data.reload(), pending.reload(), onChange()]); });
  const [f, setF] = useState({ invoiceId: '', amount: '', reason: '' });
  const [note, setNote] = useState('');
  const mine = new Set((pending.data?.items ?? []).map((r: any) => r.id));
  const tiers: any[] = data.data?.tiers ?? [];
  const closed = !['NEW', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_THIRD_PARTY', 'PENDING_DISPATCH', 'DISPATCHED', 'REOPENED'].includes(c.status);
  const inv = (invoices.data?.items ?? []).find((i: any) => i.id === f.invoiceId);
  const minor = f.amount ? toMinor(f.amount) : 0;
  const need = tiers.find((t) => t.maxMinor === null || minor <= t.maxMinor);
  return (
    <Card>
      <h2 className="mb-3 text-title3 font-semibold">Refunds</h2>
      {(data.data?.items ?? []).length === 0 ? <p className="mb-3 text-subhead text-label2">None asked for on this case.</p> : (
        <ul className="mb-4 space-y-2">{data.data.items.map((r: any) => (
          <li key={r.id} className="rounded-control bg-surface2 p-3 text-subhead">
            <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{money(r.amountMinor, r.currency)}</span><span className="text-label2">on {r.invoiceNumber}</span><Badge tone={r.status === 'EXECUTED' ? 'success' : r.status === 'PENDING' ? 'warning' : 'neutral'}>{r.status === 'EXECUTED' ? 'Refunded' : label(r.status)}</Badge>{r.status === 'PENDING' && <span className="text-footnote text-label2">needs {r.tierLabel}</span>}</div>
            <div className="text-footnote text-label2">{r.reason}</div>
            <div className="text-caption text-label2">asked by {r.requestedBy} · {dt(r.requestedAt)}{r.decidedBy && <> · {r.status === 'EXECUTED' ? 'approved' : r.status === 'REJECTED' ? 'rejected' : 'withdrawn'} by {r.decidedBy}{r.decisionNote && `: ${r.decisionNote}`}</>}</div>
            {r.status === 'PENDING' && can('case:write') && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {mine.has(r.id) && <><Input aria-label="Decision note" placeholder="Note (needed to reject)" value={note} onChange={(e) => setNote(e.target.value)} className="!min-h-[36px] max-lg:!min-h-tap max-w-xs" />
                  <Button className="!min-h-[36px] max-lg:!min-h-tap" disabled={act.busy} onClick={() => void act.run(() => post(`/refunds/${r.id}/decision`, { decision: 'APPROVE', note }), 'Approved and credited')}>Approve</Button>
                  <Button variant="secondary" className="!min-h-[36px] max-lg:!min-h-tap" disabled={act.busy || note.trim().length < 3} onClick={() => void act.run(() => post(`/refunds/${r.id}/decision`, { decision: 'REJECT', note }), 'Rejected')}>Reject</Button></>}
                <Button variant="plain" className="!min-h-[36px] max-lg:!min-h-tap" disabled={act.busy} onClick={() => void act.run(() => post(`/refunds/${r.id}/cancel`), 'Withdrawn')}>Withdraw</Button>
              </div>)}
          </li>))}</ul>)}
      {can('case:write') && !closed && (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => post(`/cases/${c.id}/refunds`, { invoiceId: f.invoiceId, amountMinor: minor, reason: f.reason }), 'Refund requested')) setF({ invoiceId: f.invoiceId, amount: '', reason: '' }); }}>
          <Field label="Invoice"><Select required value={f.invoiceId} onChange={(e) => setF({ ...f, invoiceId: e.target.value })}><option value="">Choose…</option>{(invoices.data?.items ?? []).map((i: any) => <option key={i.id} value={i.id}>{i.number} · {money(i.totalMinor, i.currency)}</option>)}</Select></Field>
          <Field label="Amount" hint={need ? `Approved by: ${need.label}${need.maxMinor !== null ? ` (up to ${money(need.maxMinor, inv?.currency)})` : ''}` : undefined}><Input required type="number" step={step()} min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Reason"><Input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
          <div className="sm:col-span-2"><Button type="submit" disabled={act.busy || !f.invoiceId || !minor}>Ask for refund</Button> <span className="ml-2 text-footnote text-label2">Within your own limit it is credited at once; above it, it waits for approval.</span></div>
        </form>)}
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}{act.ok && <div className="mt-3"><Alert tone="success">{act.ok}</Alert></div>}
    </Card>
  );
}

/** The customer cases hanging from a network incident. */
function IncidentCases({ c, onChange }: { c: any; onChange: () => Promise<void> }) {
  const { can } = useAuth();
  const kids = usePaged(`/cases/${c.id}/children?limit=20`);
  const act = useAction(async () => { await kids.reload(); await onChange(); });
  const open = !['RESOLVED', 'CLOSED_AUTO', 'CLOSED_VERIFIED'].includes(c.status);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between"><h2 className="text-title3 font-semibold">Customer cases ({c.childCount})</h2>
        {can('case:supervise') && open && <Button variant="secondary" className="!min-h-[36px] max-lg:!min-h-tap" disabled={act.busy} onClick={() => void act.run(() => post(`/cases/${c.id}/children`, { adoptNode: true }), 'Attached')}>Attach open cases at {c.postalNode}</Button>}</div>
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      {kids.items.length === 0 ? <p className="text-subhead text-label2">No cases yet.</p> : <ul className="space-y-1">{kids.items.map((k: any) => (
        <li key={k.id} className="flex flex-wrap items-center gap-2 rounded-control bg-surface2 px-3 py-2 text-subhead"><Link className="font-mono text-accent" href={`/cases/${k.id}`}>{k.number}</Link><span className="min-w-0 flex-1 truncate">{k.customerName} · {k.subject}</span><Badge>{label(k.status)}</Badge>
          {can('case:supervise') && open && <button type="button" className="text-footnote text-danger" onClick={() => void act.run(() => post(`/cases/${k.id}/unlink`), 'Removed from the incident')}>Remove</button>}</li>))}</ul>}
      {kids.hasMore && <Button variant="plain" className="mt-2" onClick={kids.loadMore} disabled={kids.loadingMore}>Show more</Button>}
    </Card>
  );
}

const VISIT: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
  RESERVED: ['Slot held', 'warning'], REQUESTED: ['Waiting for a technician', 'warning'], SCHEDULED: ['Booked', 'success'], ASSIGNED: ['Technician assigned', 'success'], EN_ROUTE: ['On the way', 'success'], ON_SITE: ['On site', 'success'],
  COMPLETED: ['Completed', 'success'], NO_ACCESS: ['Customer not at home', 'danger'], RESCHEDULE_REQUIRED: ['Needs another time', 'warning'], CANCELLED: ['Cancelled', 'neutral'], EXPIRED: ['Hold expired', 'neutral'],
};
const ACTIVE_VISIT = ['RESERVED', 'REQUESTED', 'SCHEDULED', 'ASSIGNED', 'EN_ROUTE', 'ON_SITE'];
const slotLabel = (s: { start: string; end: string }) => `${new Date(s.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} ${s.start.slice(11, 16)}–${s.end.slice(11, 16)} UTC`;

/** Technician visits: find a window, book it, follow the visit as the field-service system reports it. */
function FieldVisit({ c, onChange }: { c: any; onChange: () => Promise<void> }) {
  const { can } = useAuth();
  const visits = useApi(`/cases/${c.id}/appointments`);
  const open = ['NEW', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_THIRD_PARTY', 'PENDING_DISPATCH', 'DISPATCHED', 'REOPENED'].includes(c.status);
  const items: any[] = visits.data?.items ?? [];
  const live = items.find((v) => ACTIVE_VISIT.includes(v.status));
  const [finding, setFinding] = useState<'book' | 'reschedule' | null>(null);
  const slots = useApi(finding ? `/cases/${c.id}/slots` : null);
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const orderVisits = useApi<{ items: any[] }>(can('case:write') && open ? `/cases/${c.id}/order-visits` : null);
  const [moving, setMoving] = useState<any>(null);   // an installation booked with a customer's order, being moved from this case
  const moveSlots = useApi(moving ? `/cases/${moving.caseId}/slots` : null);
  const act = useAction(async () => { setFinding(null); setMoving(null); await Promise.all([visits.reload(), orderVisits.reload(), onChange()]); });
  if (!can('case:write') && items.length === 0) return null;
  const pick = (slot: any) => act.run(() => post(live && finding === 'reschedule' ? `/appointments/${live.id}/reschedule` : `/cases/${c.id}/appointments`, { slot, notes: notes || undefined }), 'Visit booked');
  const moveTo = (sl: any) => act.run(() => post(`/appointments/${moving.id}/reschedule`, { slot: sl, notes: notes || undefined }), 'Installation moved');
  return (
    <Card>
      <h2 className="mb-3 text-title3 font-semibold">Field visit</h2>
      {(orderVisits.data?.items ?? []).length > 0 && (
        <div className="mb-4 rounded-control border border-separator p-3">
          <p className="mb-2 text-subhead font-medium">Installations booked for this customer</p>
          <ul className="space-y-2">{orderVisits.data!.items.map((v: any) => (
            <li key={v.id} className="text-subhead"><div className="flex flex-wrap items-center gap-2"><span>Order {v.orderNumber}: {slotLabel({ start: v.slotStart, end: v.slotEnd })}</span><Badge tone={VISIT[v.status]?.[1] ?? 'neutral'}>{VISIT[v.status]?.[0] ?? label(v.status)}</Badge>
              {moving?.id !== v.id && <Button variant="secondary" onClick={() => setMoving(v)}>Move this visit</Button>}</div>
              {moving?.id === v.id && (
                <div className="mt-2 space-y-2">
                  {moveSlots.error && <Alert>{moveSlots.error}</Alert>}{!moveSlots.data && !moveSlots.error && <Spinner />}
                  {moveSlots.data && moveSlots.data.slots.length === 0 && <p className="text-subhead text-label2">No technician is free in the next two weeks.</p>}
                  {moveSlots.data && <div className="flex flex-wrap gap-2">{moveSlots.data.slots.slice(0, 24).map((sl: any) => <button key={sl.id} type="button" disabled={act.busy} onClick={() => void moveTo(sl)} className="rounded-control border border-separator bg-surface px-3 py-2 text-footnote hover:border-accent">{slotLabel(sl)}</button>)}</div>}
                  <Button variant="plain" onClick={() => setMoving(null)}>Close</Button>
                </div>)}
            </li>))}</ul>
        </div>)}
      {items.length === 0 && <p className="mb-3 text-subhead text-label2">No technician visit yet.</p>}
      <ul className="mb-3 space-y-2">{items.map((v) => (
        <li key={v.id} className="rounded-control bg-surface2 p-3 text-subhead">
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{slotLabel({ start: v.slotStart, end: v.slotEnd })}</span><Badge tone={VISIT[v.status]?.[1] ?? 'neutral'}>{VISIT[v.status]?.[0] ?? label(v.status)}</Badge>{v.externalRef && <span className="font-mono text-caption text-label2">{v.externalRef}</span>}</div>
          {(v.technicianName || v.technicianPhone) && <div className="text-footnote text-label2">Technician: {v.technicianName}{v.technicianPhone && ` · ${v.technicianPhone}`}</div>}
          {v.skills?.length > 0 && <div className="text-caption text-label2">Needs {v.skills.join(', ')}{v.equipment?.length ? ` · ${v.equipment.join(', ')} reserved` : ''}</div>}
          {v.outcomeNote && <div className="text-footnote text-label2">{v.outcomeNote}</div>}
        </li>))}</ul>
      {can('case:write') && open && (
        <div className="space-y-3">
          {!live && !finding && <div className="flex flex-wrap items-center gap-2"><Button variant="secondary" onClick={() => setFinding('book')}>Find a time for a visit</Button><Button variant="plain" disabled={act.busy} onClick={() => void act.run(() => post(`/cases/${c.id}/dispatch`, { auto: true }), 'Booked the earliest slot')}>Book the earliest slot</Button></div>}
          {live && !finding && ['RESERVED', 'REQUESTED', 'SCHEDULED', 'ASSIGNED'].includes(live.status) && <div className="flex flex-wrap items-end gap-2">
            <Button variant="secondary" onClick={() => setFinding('reschedule')}>Move the visit</Button>
            <Input aria-label="Reason for cancelling" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} className="!min-h-[40px] max-w-[220px]" />
            <Button variant="plain" disabled={act.busy} onClick={() => void act.run(() => post(`/appointments/${live.id}/cancel`, { reason }), 'Visit cancelled')}>Cancel the visit</Button></div>}
          {finding && (
            <div className="space-y-3">
              <Field label="Note for the technician"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="Gate code, pets, who to ask for…" /></Field>
              {slots.error && <Alert>{slots.error}</Alert>}
              {!slots.data && !slots.error && <Spinner />}
              {slots.data && slots.data.slots.length === 0 && <p className="text-subhead text-label2">No technician with {slots.data.skills.join(', ') || 'the right skills'} is free in the next two weeks.</p>}
              {slots.data && <div className="flex flex-wrap gap-2">{slots.data.slots.slice(0, 24).map((sl: any) => <button key={sl.id} type="button" disabled={act.busy} onClick={() => void pick(sl)} className="rounded-control border border-separator bg-surface px-3 py-2 text-footnote hover:border-accent">{slotLabel(sl)}{sl.capacityLeft !== null && <span className="ml-1 text-label2">({sl.capacityLeft} left)</span>}</button>)}</div>}
              <Button variant="plain" onClick={() => setFinding(null)}>Close</Button>
            </div>)}
          {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        </div>)}
    </Card>
  );
}
