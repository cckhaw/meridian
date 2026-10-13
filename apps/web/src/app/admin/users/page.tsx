'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, LoadMore, SearchField, SectionTitle, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { patch, post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { StorePicker } from '@/app/stores/store-picker';
import { dt, label, money } from '@/lib/format';

interface Role { id: string; label: string; summary: string; scope: string; permissions: string[]; creditLimitMinor?: number | null }

export default function Users() {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const users = usePaged(`/users?limit=25&q=${encodeURIComponent(term)}`);
  const roles = useApi('/roles');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);
  const act = useAction(users.reload);
  const roleList: Role[] = roles.data ?? [];
  const roleLabel = (id: string) => roleList.find((r) => r.id === id)?.label ?? id;

  return (
    <>
      <LargeTitle subtitle="Create staff and portal logins and decide what each can do">Users & roles</LargeTitle>
      {secret && (
        <div className="mb-4"><Alert tone="success">
          Temporary password for <strong>{secret.who}</strong>: <code className="select-all rounded bg-surface px-2 py-1 font-mono text-body">{secret.password}</code>
          <span className="ml-2 text-footnote">Shown once. Give it to them securely; they must change it at first sign-in.</span>
          <button className="ml-3 text-accent" onClick={() => setSecret(null)}>Dismiss</button>
        </Alert></div>
      )}
      <div className="mb-4 flex items-center gap-3"><SearchField label="Search users" placeholder="Username starts with…" value={q} onChange={setQ} className="md:max-w-sm md:flex-1" /><span className="flex-1" /><Button onClick={() => { setCreating(!creating); setEditing(null); }}>{creating ? 'Close' : 'New user'}</Button></div>
      {creating && <UserForm roles={roleList} onDone={(r) => { setCreating(false); if (r?.temporaryPassword) setSecret({ who: r.user.username, password: r.temporaryPassword }); void users.reload(); }} />}
      {editing && <EditUser user={editing} roles={roleList} onDone={() => { setEditing(null); void users.reload(); }} />}
      {act.error && <Alert>{act.error}</Alert>}
      {users.error && <Alert>{users.error}</Alert>}
      {users.loading && users.items.length === 0 && <Spinner />}
      {!users.loading && users.items.length === 0 && !users.error && <Empty>{term ? 'No users match.' : 'No staff users yet. Create the first one above.'}</Empty>}
      {users.items.length > 0 && (
        <>
        <TableWrap><thead><tr><Th>User</Th><Th>Roles</Th><Th>Scope</Th><Th>Status</Th><Th>Last sign-in</Th><Th /></tr></thead><tbody>
          {users.items.map((u: any) => (
            <tr key={u.id}>
              <Td><span className="font-medium">{u.displayName}</span><div className="font-mono text-caption text-label2">{u.username}</div></Td>
              <Td><span className="flex flex-wrap gap-1">{u.roles.map((r: string) => <Badge key={r}>{roleLabel(r)}</Badge>)}</span></Td>
              <Td className="text-footnote text-label2">{[u.storeId && `store ${u.storeId}`, u.dealerId && `dealer ${u.dealerId}`, u.customerId && 'portal customer'].filter(Boolean).join(' · ') || '—'}</Td>
              <Td><Badge tone={u.status === 'ACTIVE' ? 'success' : 'neutral'}>{label(u.status)}</Badge>{u.locked && <Badge tone="danger">Locked</Badge>}{u.mustChangePassword && <Badge tone="warning">Temp password</Badge>}</Td>
              <Td>{u.lastLoginAt ? dt(u.lastLoginAt) : 'Never'}</Td>
              <Td right><span className="flex justify-end gap-1">
                <Button variant="plain" className="!min-h-[36px] !px-3" onClick={() => { setEditing(u); setCreating(false); }}>Edit</Button>
                {u.locked && <Button variant="plain" className="!min-h-[36px] !px-3" onClick={() => act.run(() => post(`/users/${u.id}/unlock`))}>Unlock</Button>}
                <Button variant="plain" className="!min-h-[36px] !px-3" disabled={act.busy} onClick={async () => { if (confirm(`Reset the password for ${u.username}? They will be signed out everywhere.`)) { const r = await act.run(() => post(`/users/${u.id}/reset-password`)); if (r) setSecret({ who: u.username, password: r.temporaryPassword }); } }}>Reset password</Button>
              </span></Td>
            </tr>
          ))}
        </tbody></TableWrap>
        <LoadMore shown={users.items.length} hasMore={users.hasMore} loading={users.loadingMore} onMore={users.loadMore} noun="users" />
        </>
      )}

      <SectionTitle>What each role can do</SectionTitle>
      <div className="grid gap-3 md:grid-cols-2">
        {roleList.map((r) => (
          <Card key={r.id} className="!p-4">
            <div className="flex items-start justify-between gap-2"><h3 className="font-semibold">{r.label}</h3><Badge>{r.scope === 'staff' ? 'All records' : `Own ${r.scope}`}</Badge></div>
            <p className="mt-1 text-subhead text-label2">{r.summary}</p>
            <p className="mt-2 text-caption text-label2">{r.permissions.length} permissions{r.creditLimitMinor === null ? ' · unlimited credit notes' : r.creditLimitMinor ? ` · credit notes up to ${money(r.creditLimitMinor)}` : ''}</p>
          </Card>
        ))}
      </div>
    </>
  );
}

const needs = (roles: Role[], picked: string[], scope: string) => roles.some((r) => picked.includes(r.id) && r.scope === scope);

function RolePicker({ roles, value, onChange }: { roles: Role[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="mb-1 text-subhead font-medium">Roles</legend>
      {roles.map((r) => (
        <label key={r.id} className="flex min-h-tap cursor-pointer items-start gap-3 rounded-control bg-surface2 p-3">
          <input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={value.includes(r.id)} onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))} />
          <span><span className="font-medium">{r.label}</span><span className="block text-footnote text-label2">{r.summary}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

function UserForm({ roles, onDone }: { roles: Role[]; onDone: (r?: any) => void }) {
  const [f, setF] = useState({ username: '', displayName: '', email: '', roles: [] as string[], storeId: '', dealerId: '', customerId: '' });
  const { run, busy, error } = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card className="mb-6">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => post('/users', { ...f, storeId: f.storeId || undefined, dealerId: f.dealerId || undefined, customerId: f.customerId || undefined, email: f.email || undefined })); if (r) onDone(r); }}>
        <Field label="Username" hint="3-50 characters: letters, digits, dot, dash, underscore"><Input required value={f.username} onChange={set('username')} autoCapitalize="none" /></Field>
        <Field label="Full name"><Input required value={f.displayName} onChange={set('displayName')} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <div className="sm:col-span-2"><RolePicker roles={roles} value={f.roles} onChange={(v) => setF({ ...f, roles: v })} /></div>
        {needs(roles, f.roles, 'store') && <Field label="Store" hint="The store whose orders and stock they can see. Add stores under Stores."><StorePicker value={f.storeId} onChange={(id) => setF({ ...f, storeId: id })} /></Field>}
        {needs(roles, f.roles, 'dealer') && <Field label="Dealer ID" hint="Their orders and commission are limited to this dealer"><Input required value={f.dealerId} onChange={set('dealerId')} /></Field>}
        {needs(roles, f.roles, 'customer') && <Field label="Customer ID" hint="Open the customer’s page and copy the id from the address bar. One portal login per customer."><Input required value={f.customerId} onChange={set('customerId')} /></Field>}
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="sm:col-span-2"><Button type="submit" disabled={busy || f.roles.length === 0 || (needs(roles, f.roles, 'store') && !f.storeId)}>{busy ? 'Creating…' : 'Create user'}</Button><span className="ml-3 text-footnote text-label2">A one-time password is generated for you to hand over.</span></div>
      </form>
    </Card>
  );
}

function EditUser({ user, roles, onDone }: { user: any; roles: Role[]; onDone: () => void }) {
  const [f, setF] = useState({ displayName: user.displayName, email: user.email ?? '', roles: user.roles as string[], storeId: user.storeId ?? '', dealerId: user.dealerId ?? '', status: user.status });
  const { run, busy, error } = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card className="mb-6 border border-accent/30">
      <h2 className="mb-3 text-title3 font-semibold">Edit {user.username}</h2>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => patch(`/users/${user.id}`, { displayName: f.displayName, email: f.email || undefined, roles: f.roles, status: f.status, storeId: f.storeId || null, dealerId: f.dealerId || null }))) onDone(); }}>
        <Field label="Full name"><Input required value={f.displayName} onChange={set('displayName')} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Status" hint="Disabling signs them out immediately"><Select value={f.status} onChange={set('status')}><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option></Select></Field>
        <div className="sm:col-span-2"><RolePicker roles={roles} value={f.roles} onChange={(v) => setF({ ...f, roles: v })} /></div>
        {needs(roles, f.roles, 'store') && <Field label="Store"><StorePicker value={f.storeId} onChange={(id) => setF({ ...f, storeId: id })} /></Field>}
        {needs(roles, f.roles, 'dealer') && <Field label="Dealer ID"><Input required value={f.dealerId} onChange={set('dealerId')} /></Field>}
        <p className="text-footnote text-label2 sm:col-span-2">Changing roles or scope signs the user out so the new access applies at once.</p>
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={busy || f.roles.length === 0 || (needs(roles, f.roles, 'store') && !f.storeId)}>Save</Button><Button type="button" variant="secondary" onClick={onDone}>Cancel</Button></div>
      </form>
    </Card>
  );
}
