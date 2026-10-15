'use client';
import { Alert, Button, Card, Empty, Field, Input, SectionTitle, Select, TableWrap, Td, Textarea, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { CaseBadges, IssueTypePicker, SlaPill } from '../../cases/parts';
import { dt } from '@/lib/format';

export function CasesPanel({ customerId, cases, onChange }: { customerId: string; cases: any[]; onChange: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const meta = useApi(open ? '/cases/meta' : null);
  const [f, setF] = useState({ issueTypeId: '', subject: '', note: '', severity: '' });
  const { run, busy, error } = useAction(onChange);
  const issue = f.issueTypeId && meta.data ? findNode(meta.data.taxonomy, f.issueTypeId) : null;
  return (
    <>
      <SectionTitle action={can('case:create') ? <Button variant="plain" className="!min-h-[36px]" onClick={() => setOpen(!open)}>{open ? 'Close' : 'New case'}</Button> : undefined}>Cases</SectionTitle>
      {open && (
        <Card className="mb-4"><form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post('/cases', { customerId, issueTypeId: f.issueTypeId, subject: f.subject, ...(f.note ? { note: f.note } : {}), ...(f.severity ? { severity: f.severity } : {}), channel: 'CALL_CENTER' }))) { setOpen(false); setF({ issueTypeId: '', subject: '', note: '', severity: '' }); } }}>
          <div className="sm:col-span-2">{meta.data ? <IssueTypePicker tree={meta.data.taxonomy} value={f.issueTypeId} onChange={(v) => setF({ ...f, issueTypeId: v })} /> : <p className="text-footnote text-label2">Loading…</p>}</div>
          <Field label="Severity" hint={issue ? `Usually ${issue.defaultSeverity.replace(/_/g, ' ').toLowerCase()} for this issue. It sets how fast the SLA clock runs.` : undefined}>
            <Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}><option value="">Usual for the issue</option>{(meta.data?.severities ?? []).map((s: string) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</option>)}</Select></Field>
          <Field label="Subject"><Input required value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Notes"><Textarea rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div>
          {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
          <div className="sm:col-span-2"><Button type="submit" disabled={busy || !f.issueTypeId}>Create case</Button></div>
        </form></Card>
      )}
      {cases.length === 0 ? <Empty>No cases.</Empty> : (
        <TableWrap><thead><tr><Th>Case</Th><Th>Subject</Th><Th>Status</Th><Th>SLA</Th><Th>Opened</Th></tr></thead><tbody>
          {cases.map((k: any) => <tr key={k.id}><Td><Link className="font-mono text-accent" href={`/cases/${k.id}`}>{k.number}</Link></Td><Td>{k.subject}<div className="text-caption text-label2">{k.categoryPath}</div></Td><Td><CaseBadges c={k} /></Td><Td><SlaPill sla={k.sla} /></Td><Td>{dt(k.createdAt)}</Td></tr>)}
        </tbody></TableWrap>
      )}
    </>
  );
}

function findNode(tree: any[], id: string): any {
  for (const n of tree) { if (n.id === id) return n; const c = n.children && findNode(n.children, id); if (c) return c; }
  return null;
}
