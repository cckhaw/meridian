'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, SectionTitle, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';

interface Operator { id: string; name: string; mnpOperatorId: string; status: 'ACTIVE' | 'INACTIVE'; inUse: number }

/** The operators numbers can be ported in from. Orders pick the donor from this list; the operator ID, the identifier the operator has in mobile number portability (MNP), goes with the request. */
export function DonorOperatorSettings() {
  const list = useApi<{ items: Operator[] }>('/settings/donor-operators');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', code: '' });
  const add = useAction(list.reload);
  const act = useAction(list.reload);
  if (list.error) return <Alert>{list.error}</Alert>;
  if (!list.data) return <Spinner />;
  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Add an operator</SectionTitle>
        <form className="form-row" onSubmit={async (e) => { e.preventDefault(); if (await add.run(() => post('/settings/donor-operators', { name, mnpOperatorId: code }), 'Added.')) { setName(''); setCode(''); } }}>
          <Field label="Operator name"><Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="Operator ID (MNP)"><Input value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} required className="font-mono" /></Field>
          <Button type="submit" disabled={add.busy}>{add.busy ? 'Adding…' : 'Add'}</Button>
        </form>
        <p className="mt-2 text-footnote text-label2">The operator ID is the operator’s identifier in mobile number portability (MNP). Two operators may share one.</p>
        {add.error && <div className="mt-3"><Alert>{add.error}</Alert></div>}
      </Card>
      {act.error && <Alert>{act.error}</Alert>}
      {list.data.items.length === 0 ? <Empty>No donor operators yet. Orders cannot port a number in until you add the operators customers come from.</Empty> : (
        <DataList label="Donor operators" rows={list.data.items} rowKey={(o) => o.id}
          columns={[
            { key: 'name', label: 'Operator', primary: true, render: (o) => (editing === o.id ? <Input aria-label="Operator name" value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /> : <span className="font-medium">{o.name}</span>) },
            { key: 'id', label: 'Operator ID', render: (o) => (editing === o.id ? <Input aria-label="Operator ID" className="font-mono md:min-w-[8rem]" value={draft.code} maxLength={20} onChange={(e) => setDraft({ ...draft, code: e.target.value })} /> : <span className="font-mono">{o.mnpOperatorId}</span>) },
            { key: 'status', label: 'Status', render: (o) => <Badge tone={o.status === 'ACTIVE' ? 'success' : 'neutral'}>{o.status === 'ACTIVE' ? 'Offered' : 'Switched off'}</Badge> },
            { key: 'requests', label: 'Requests', right: true, render: (o) => <span className="tabular-nums">{o.inUse}</span> },
          ]}
          actions={(o) => (editing === o.id ? (
            <>
              <Button disabled={act.busy} onClick={async () => { if (await act.run(() => patch(`/settings/donor-operators/${o.id}`, { name: draft.name, mnpOperatorId: draft.code }))) setEditing(null); }}>Save</Button>
              <Button variant="plain" onClick={() => setEditing(null)}>Cancel</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" disabled={act.busy} onClick={() => { setEditing(o.id); setDraft({ name: o.name, code: o.mnpOperatorId }); }}>Edit</Button>
              <Button variant="secondary" disabled={act.busy} onClick={() => act.run(() => patch(`/settings/donor-operators/${o.id}`, { status: o.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }))}>{o.status === 'ACTIVE' ? 'Switch off' : 'Switch on'}</Button>
              <Button variant="plain" disabled={act.busy} onClick={() => { if (window.confirm(o.inUse ? `${o.name} has port-in requests, so it will be switched off, not removed.` : `Remove ${o.name}?`)) void act.run(() => del(`/settings/donor-operators/${o.id}`)); }}>Remove</Button>
            </>
          ))} />
      )}
      <p className="text-footnote text-label2">Switching an operator off hides it from new orders; requests already raised keep its name and operator ID as they were. Renaming never changes an existing request.</p>
    </div>
  );
}
