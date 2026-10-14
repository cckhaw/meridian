'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, SectionTitle, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';

interface Operator { id: string; name: string; routingCode: string; status: 'ACTIVE' | 'INACTIVE'; inUse: number }

/** The operators numbers can be ported in from. Orders pick the donor from this list; the routing code goes with the request to the clearinghouse. */
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
        <form className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end" onSubmit={async (e) => { e.preventDefault(); if (await add.run(() => post('/settings/donor-operators', { name, routingCode: code }), 'Added.')) { setName(''); setCode(''); } }}>
          <Field label="Operator name"><Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="Routing code" hint="From the clearinghouse"><Input value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} required className="font-mono" /></Field>
          <Button type="submit" disabled={add.busy}>{add.busy ? 'Adding…' : 'Add'}</Button>
        </form>
        {add.error && <div className="mt-3"><Alert>{add.error}</Alert></div>}
      </Card>
      {act.error && <Alert>{act.error}</Alert>}
      {list.data.items.length === 0 ? <Empty>No donor operators yet. Orders cannot port a number in until you add the operators customers come from.</Empty> : (
        <TableWrap><thead><tr><Th>Operator</Th><Th>Routing code</Th><Th>Status</Th><Th>Requests</Th><Th /></tr></thead><tbody>
          {list.data.items.map((o) => (
            <tr key={o.id}>
              {editing === o.id ? (
                <>
                  <Td><Input aria-label="Operator name" value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Td>
                  <Td><Input aria-label="Routing code" className="font-mono" value={draft.code} maxLength={20} onChange={(e) => setDraft({ ...draft, code: e.target.value })} /></Td>
                  <Td /><Td />
                  <Td right><span className="flex justify-end gap-2"><Button disabled={act.busy} onClick={async () => { if (await act.run(() => patch(`/settings/donor-operators/${o.id}`, { name: draft.name, routingCode: draft.code }))) setEditing(null); }}>Save</Button><Button variant="plain" onClick={() => setEditing(null)}>Cancel</Button></span></Td>
                </>
              ) : (
                <>
                  <Td>{o.name}</Td><Td className="font-mono">{o.routingCode}</Td>
                  <Td><Badge tone={o.status === 'ACTIVE' ? 'success' : 'neutral'}>{o.status === 'ACTIVE' ? 'Offered in orders' : 'Switched off'}</Badge></Td>
                  <Td className="tabular-nums">{o.inUse}</Td>
                  <Td right><span className="flex justify-end gap-2">
                    <Button variant="secondary" disabled={act.busy} onClick={() => { setEditing(o.id); setDraft({ name: o.name, code: o.routingCode }); }}>Edit</Button>
                    <Button variant="plain" disabled={act.busy} onClick={() => act.run(() => patch(`/settings/donor-operators/${o.id}`, { status: o.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }))}>{o.status === 'ACTIVE' ? 'Switch off' : 'Switch on'}</Button>
                    <Button variant="plain" disabled={act.busy} onClick={() => { if (window.confirm(o.inUse ? `${o.name} has port-in requests, so it will be switched off, not removed.` : `Remove ${o.name}?`)) void act.run(() => del(`/settings/donor-operators/${o.id}`)); }}>Remove</Button>
                  </span></Td>
                </>
              )}
            </tr>
          ))}
        </tbody></TableWrap>
      )}
      <p className="text-footnote text-label2">Switching an operator off hides it from new orders; requests already raised keep its name and routing code as they were. Renaming never changes an existing request.</p>
    </div>
  );
}
