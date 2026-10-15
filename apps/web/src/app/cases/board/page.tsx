'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, SectionTitle, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label, money } from '@/lib/format';
import { IssueTypePicker, sevTone } from '../parts';

/** The supervisor's board: what is late or close to it, network incidents, and refunds waiting for a decision. */
export default function Board() {
  const { can } = useAuth();
  const sup = can('case:supervise');
  const board = useApi(sup ? '/cases/sla-board' : null);
  const incidents = useApi('/cases/incidents?limit=20');
  const suggestions = useApi(sup ? '/cases/incidents/suggestions' : null);
  const pending = useApi(can('case:write') ? '/refunds/pending' : null);
  const meta = useApi(sup ? '/cases/meta' : null);
  const all = async () => { await Promise.all([board.reload(), incidents.reload(), suggestions.reload(), pending.reload()]); };
  const act = useAction(all);
  const [f, setF] = useState({ postalNode: '', issueTypeId: '', subject: '' });
  const [note, setNote] = useState('');
  if (!can('case:read')) return <Alert>Your role does not include cases.</Alert>;
  return (
    <>
      <LargeTitle subtitle="What is past its service level, network incidents, and refunds waiting for a decision">Supervisor board</LargeTitle>
      <p className="mb-4 text-footnote text-label2"><Link className="text-accent" href="/cases">← Cases</Link></p>
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}

      {sup && <>
        <SectionTitle action={<Button variant="plain" className="!min-h-[36px] max-lg:!min-h-tap" disabled={act.busy} onClick={() => void act.run(async () => { const r = await post('/cases/sla-sweep'); return r; }, 'Checked every open case')}>Check now</Button>}>Service levels</SectionTitle>
        {!board.data ? <Spinner /> : board.data.breached.length + board.data.warning.length === 0 ? <Empty>Nothing is past its service level or close to it.</Empty> : (
          <TableWrap><thead><tr><Th>Case</Th><Th>Subject</Th><Th>Severity</Th><Th>Assigned</Th><Th>State</Th><Th>Due</Th></tr></thead><tbody>
            {[...board.data.breached.map((k: any) => ({ ...k, late: true })), ...board.data.warning.map((k: any) => ({ ...k, late: false }))].map((k: any) => (
              <tr key={k.id}><Td><Link className="font-mono text-accent" href={`/cases/${k.id}`}>{k.number}</Link></Td><Td>{k.subject}</Td><Td><Badge tone={sevTone(k.severity)}>{label(k.severity)}</Badge></Td><Td>{k.assignee ?? <span className="text-danger">Unassigned</span>}</Td>
                <Td>{k.late ? <Badge tone="danger">{k.escalationLevel > 1 ? 'Escalated twice' : 'Breached'}</Badge> : <Badge tone="warning">Close to breach</Badge>}</Td><Td className="whitespace-nowrap">{dt(k.resolutionDue)}</Td></tr>))}
          </tbody></TableWrap>)}
      </>}

      <SectionTitle>Network incidents</SectionTitle>
      {(incidents.data?.items ?? []).length === 0 ? <Empty>No open network incidents.</Empty> : (
        <TableWrap><thead><tr><Th>Incident</Th><Th>Node</Th><Th>Subject</Th><Th>Status</Th><Th>Opened</Th></tr></thead><tbody>
          {incidents.data.items.map((k: any) => <tr key={k.id}><Td><Link className="font-mono text-accent" href={`/cases/${k.id}`}>{k.number}</Link></Td><Td className="font-mono">{k.postalNode}</Td><Td>{k.subject}</Td><Td><Badge>{label(k.status)}</Badge></Td><Td className="whitespace-nowrap">{dt(k.createdAt)}</Td></tr>)}
        </tbody></TableWrap>)}
      {sup && (suggestions.data?.items ?? []).length > 0 && (
        <Card className="mt-4"><h3 className="mb-2 text-subhead font-semibold">Nodes with several fault cases</h3>
          <ul className="space-y-2">{suggestions.data.items.map((s: any) => (
            <li key={s.postalNode} className="flex flex-wrap items-center gap-3 rounded-control bg-surface2 px-3 py-2 text-subhead"><span className="font-mono">{s.postalNode}</span><span>{s.cases} cases since {dt(s.oldestAt)}</span>
              <Button className="ml-auto !min-h-[36px] max-lg:!min-h-tap" disabled={act.busy} onClick={() => void act.run(() => post('/cases/incidents', { postalNode: s.postalNode, issueTypeId: s.issueTypeId, subject: `Network incident at ${s.postalNode}: ${s.cases} customers affected` }), 'Incident created')}>Group into an incident</Button></li>))}</ul></Card>)}
      {sup && meta.data && (
        <Card className="mt-4 space-y-3"><h3 className="text-subhead font-semibold">Open an incident</h3>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Postal node" hint="The postcode or node code of the fault"><Input value={f.postalNode} onChange={(e) => setF({ ...f, postalNode: e.target.value })} className="font-mono" maxLength={20} /></Field>
            <Field label="Subject (optional)"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field></div>
          <IssueTypePicker tree={meta.data.taxonomy.map((c: any) => ({ ...c, children: c.children.map((s: any) => ({ ...s, children: s.children.filter((i: any) => i.caseType === 'FIBER_ASSURANCE' || i.caseType === 'GENERAL') })) }))} value={f.issueTypeId} onChange={(v) => setF({ ...f, issueTypeId: v })} />
          <Button disabled={act.busy || !f.postalNode.trim() || !f.issueTypeId} onClick={() => void act.run(() => post('/cases/incidents', { postalNode: f.postalNode, issueTypeId: f.issueTypeId, ...(f.subject ? { subject: f.subject } : {}) }), 'Incident opened; the open cases at that node were attached')}>Open incident</Button>
        </Card>)}

      {can('case:write') && <>
        <SectionTitle>Refunds waiting for you</SectionTitle>
        {(pending.data?.items ?? []).length === 0 ? <Empty>Nothing is waiting for your approval.</Empty> : (
          <ul className="space-y-2">{pending.data.items.map((r: any) => (
            <li key={r.id} className="rounded-control bg-surface p-3 text-subhead shadow-card">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{money(r.amountMinor, r.currency)}</span><span className="text-label2">on {r.invoiceNumber} · {r.customerName}</span><Link className="font-mono text-accent" href={`/cases/${r.caseId}`}>{r.caseNumber}</Link><Badge tone="warning">{r.tierLabel}</Badge></div>
              <div className="text-footnote text-label2">{r.reason} · asked by {r.requestedBy}, {dt(r.requestedAt)}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2"><Input aria-label="Decision note" placeholder="Note (needed to reject)" value={note} onChange={(e) => setNote(e.target.value)} className="!min-h-[36px] max-lg:!min-h-tap max-w-xs" />
                <Button className="!min-h-[36px] max-lg:!min-h-tap" disabled={act.busy} onClick={() => void act.run(() => post(`/refunds/${r.id}/decision`, { decision: 'APPROVE', note }), 'Approved and credited')}>Approve</Button>
                <Button variant="secondary" className="!min-h-[36px] max-lg:!min-h-tap" disabled={act.busy || note.trim().length < 3} onClick={() => void act.run(() => post(`/refunds/${r.id}/decision`, { decision: 'REJECT', note }), 'Rejected')}>Reject</Button></div></li>))}</ul>)}
      </>}
    </>
  );
}
