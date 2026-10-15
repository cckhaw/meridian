'use client';
import { Alert, Badge, Button, Card, Field, Input, LargeTitle, Modal, Select, Spinner, Textarea } from '@meridian/ui';
import Link from 'next/link';
import { use, useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label } from '@/lib/format';
import { CaseBadges, SlaPill, sevTone } from '../parts';

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
      <p className="mb-1">Customer {can('customer:search') ? <Link className="text-accent" href={`/customers/${c.customerId}`}>{c.customerName}</Link> : c.customerName} · opened {dt(c.createdAt)}{c.assignee && <> · assigned to <strong>{c.assignee}</strong>{c.team && ` (${c.team})`}</>}</p>
      {c.categoryPath && <p className="mb-4 text-footnote text-label2">{c.categoryPath}</p>}
      {c.type === 'BILLING_REFUND' && <Alert tone="info">To refund, open the customer’s invoice and issue a credit note; mention this case number in the reason.</Alert>}
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
          <Card>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-title3 font-semibold">Interactions on this case</h2>{can('case:create') && <Button variant="plain" className="!min-h-[36px]" onClick={() => setLogOpen(!logOpen)}>{logOpen ? 'Close' : 'Log an interaction'}</Button>}</div>
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
