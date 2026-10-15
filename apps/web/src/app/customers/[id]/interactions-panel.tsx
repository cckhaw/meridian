'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LoadMore, SectionTitle, Select, Textarea } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { post, useAction, useApi, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label } from '@/lib/format';

/** Every touchpoint with the customer on any channel. An interaction that is not on a case yet can open one. */
export function InteractionsPanel({ customerId, onChange }: { customerId: string; onChange: () => void }) {
  const { can } = useAuth();
  const list = usePaged(`/interactions?customerId=${customerId}&limit=10`);
  const meta = useApi(can('case:create') ? '/cases/meta' : null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ channel: 'CALL_CENTER', direction: 'INBOUND', subject: '', summary: '' });
  const act = useAction(async () => { await list.reload(); onChange(); });
  return (
    <>
      <SectionTitle action={can('case:create') ? <Button variant="plain" className="!min-h-[36px] max-lg:!min-h-tap" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Log an interaction'}</Button> : undefined}>Interactions</SectionTitle>
      {open && (
        <Card className="mb-4"><form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => post('/interactions', { customerId, ...f }))) { setOpen(false); setF({ ...f, subject: '', summary: '' }); } }}>
          <Field label="Channel"><Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{(meta.data?.channels ?? ['CALL_CENTER']).map((ch: string) => <option key={ch} value={ch}>{label(ch)}</option>)}</Select></Field>
          <Field label="Direction"><Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="INBOUND">The customer contacted us</option><option value="OUTBOUND">We contacted the customer</option></Select></Field>
          <div className="sm:col-span-2"><Field label="Subject"><Input required value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field></div>
          <div className="sm:col-span-2"><Field label="What was said"><Textarea rows={3} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field></div>
          {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
          <div className="sm:col-span-2"><Button type="submit" disabled={act.busy}>Save interaction</Button></div>
        </form></Card>
      )}
      {list.error && <Alert>{list.error}</Alert>}
      {list.items.length === 0 && !list.loading ? <Empty>No interactions logged.</Empty> : (
        <ul className="space-y-2">{list.items.map((i: any) => (
          <li key={i.id} className="rounded-control bg-surface p-3 text-subhead shadow-card">
            <div className="flex flex-wrap items-center gap-2"><Badge>{label(i.channel)}</Badge><Badge tone={i.direction === 'INBOUND' ? 'neutral' : 'success'}>{i.direction === 'INBOUND' ? 'In' : 'Out'}</Badge><span className="font-medium">{i.subject}</span>
              {i.caseId ? <Link className="ml-auto font-mono text-footnote text-accent" href={`/cases/${i.caseId}`}>{i.caseNumber}</Link> : can('case:create') && <button type="button" className="ml-auto text-footnote text-accent" disabled={act.busy} onClick={() => void act.run(async () => { const k = await post(`/interactions/${i.id}/case`, { issueTypeId: 'general.enquiry.any' }); window.location.assign(`/cases/${k.id}`); })}>Open a case</button>}</div>
            {i.summary && <div className="mt-1 text-footnote text-label2">{i.summary}</div>}<div className="text-caption text-label2">{i.agent ?? i.createdBy} · {dt(i.occurredAt)}</div></li>))}</ul>
      )}
      <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="interactions" />
    </>
  );
}
