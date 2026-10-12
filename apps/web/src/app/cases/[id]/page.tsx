'use client';
import { Alert, Badge, Button, Card, Field, LargeTitle, Select, Spinner, Textarea } from '@meridian/ui';
import Link from 'next/link';
import { use, useState } from 'react';
import { patch, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label, tone } from '@/lib/format';

export default function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const { data: c, error, loading, reload } = useApi(`/cases/${id}`);
  const [note, setNote] = useState('');
  const { run, busy, error: aerr } = useAction(reload);
  if (error) return <Alert>{error}</Alert>;
  if (loading && !c) return <Spinner />;
  if (!c) return null;
  return (
    <>
      <LargeTitle subtitle={<span className="flex flex-wrap items-center gap-2"><Badge>{label(c.type)}</Badge><Badge tone={tone(c.priority)}>{label(c.priority)}</Badge><Badge tone={tone(c.status)}>{label(c.status)}</Badge></span>}>{c.number}: {c.subject}</LargeTitle>
      <p className="mb-4">Customer {can('customer:search') ? <Link className="text-accent" href={`/customers/${c.customerId}`}>{c.customerName}</Link> : c.customerName} · opened {dt(c.createdAt)}</p>
      {c.type === 'BILLING_REFUND' && <Alert tone="info">To refund, open the customer’s invoice and issue a credit note; mention this case number in the reason.</Alert>}
      {aerr && <Alert>{aerr}</Alert>}
      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <h2 className="mb-3 text-title3 font-semibold">Notes</h2>
          <ul className="space-y-3">{c.notes.map((n: any, i: number) => <li key={i} className="rounded-control bg-surface2 p-3 text-subhead">{n.text}<div className="text-caption text-label2">{n.by} · {dt(n.at)}</div></li>)}{c.notes.length === 0 && <li className="text-label2">No notes yet.</li>}</ul>
          {can('case:write') && <form className="mt-4 space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => patch(`/cases/${id}`, { note }))) setNote(''); }}>
            <Field label="Add note"><Textarea rows={3} required value={note} onChange={(e) => setNote(e.target.value)} /></Field><Button type="submit" disabled={busy}>Add note</Button>
          </form>}
        </Card>
        {can('case:write') && <Card className="space-y-3 lg:self-start"><h2 className="text-title3 font-semibold">Update</h2>
          <Field label="Status"><Select value={c.status} onChange={(e) => run(() => patch(`/cases/${id}`, { status: e.target.value }))}>{['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select></Field>
          <Field label="Priority"><Select value={c.priority} onChange={(e) => run(() => patch(`/cases/${id}`, { priority: e.target.value }))}>{['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select></Field>
        </Card>}
      </div>
    </>
  );
}
