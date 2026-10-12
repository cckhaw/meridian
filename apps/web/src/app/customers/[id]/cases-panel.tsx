'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, SectionTitle, Select, TableWrap, Td, Textarea, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { post, useAction } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label, tone } from '@/lib/format';

export function CasesPanel({ customerId, cases, onChange }: { customerId: string; cases: any[]; onChange: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ type: 'GENERAL', subject: '', note: '', priority: 'NORMAL' });
  const { run, busy, error } = useAction(onChange);
  return (
    <>
      <SectionTitle action={can('case:create') ? <Button variant="plain" className="!min-h-[36px]" onClick={() => setOpen(!open)}>{open ? 'Close' : 'New case'}</Button> : undefined}>Cases</SectionTitle>
      {open && (
        <Card className="mb-4"><form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post('/cases', { customerId, ...f }))) { setOpen(false); setF({ ...f, subject: '', note: '' }); } }}>
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['GENERAL', 'FIBER_ASSURANCE', 'BILLING_REFUND'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
          <Field label="Priority"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
          <div className="sm:col-span-2"><Field label="Subject"><Input required value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field></div>
          <div className="sm:col-span-2"><Field label="Notes"><Textarea rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div>
          {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
          <div className="sm:col-span-2"><Button type="submit" disabled={busy}>Create case</Button></div>
        </form></Card>
      )}
      {cases.length === 0 ? <Empty>No cases.</Empty> : (
        <TableWrap><thead><tr><Th>Case</Th><Th>Type</Th><Th>Subject</Th><Th>Status</Th><Th>Opened</Th></tr></thead><tbody>
          {cases.map((k: any) => <tr key={k.id}><Td><Link className="font-mono text-accent" href={`/cases/${k.id}`}>{k.number}</Link></Td><Td>{label(k.type)}</Td><Td>{k.subject}</Td><Td><Badge tone={tone(k.status)}>{label(k.status)}</Badge></Td><Td>{dt(k.createdAt)}</Td></tr>)}
        </tbody></TableWrap>
      )}
    </>
  );
}
