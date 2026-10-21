'use client';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '@meridian/ui';
import { useMemo, useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';

export interface RoleView { custom: boolean; code?: string; disabled: boolean; home: string; id: string; label: string; summary: string; scope: string; permissions: string[]; defaults: string[]; creditLimitMinor?: number | null; defaultCreditLimitMinor?: number | null; customised: boolean; users: number; modules: string[]; grantsSuperuser: boolean }
interface PermInfo { id: string; key: string; domain: string; group: string; label: string; hint: string; superuserGrant: boolean }

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Roles and permissions: pick a role, tick what it may do, save. "Reset to default" returns it to the built-in set. */
export function RolesEditor({ roles, onChanged }: { roles: RoleView[]; onChanged: () => void }) {
  const catalogue = useApi<{ permissions: PermInfo[]; landing: Array<{ href: string; label: string }> }>('/roles/permissions');
  const [sel, setSel] = useState<string>('retail-store');
  const [creating, setCreating] = useState(false);
  const role = roles.find((r) => r.id === sel) ?? roles[0];
  if (!role) return <Spinner />;
  if (!catalogue.data) return <Spinner />;
  const nav = (
    <>
      <Button className="mb-3 w-full" onClick={() => setCreating(true)}>New role</Button>
      {creating && <NewRole roles={roles} landing={catalogue.data.landing} onCancel={() => setCreating(false)} onDone={(id) => { setCreating(false); setSel(id); onChanged(); }} />}
    </>
  );
  return <Editor key={role.id} role={role} roles={roles} setSel={(id) => { setCreating(false); setSel(id); }} catalogue={catalogue.data.permissions} landing={catalogue.data.landing} top={nav} onChanged={onChanged} onDeleted={() => { setSel('retail-store'); onChanged(); }} />;
}

/** Create a role: a name, what it sees, where it lands, and a starting set of permissions copied from an existing role (ticked off afterwards). */
function NewRole({ roles, landing, onCancel, onDone }: { roles: RoleView[]; landing: Array<{ href: string; label: string }>; onCancel: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState({ name: '', summary: '', scope: 'staff', home: '/', copyFrom: '' });
  const { run, busy, error } = useAction();
  const su = !!useAuth().me?.isSuperuser;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="mb-4 space-y-3 rounded-control border border-accent/30 bg-surface p-3" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => post('/roles', { name: f.name, summary: f.summary || undefined, scope: f.scope, home: f.home, copyFrom: f.copyFrom || undefined })); if (r) onDone(r.id); }}>
      <Field label="Role name"><Input required autoFocus maxLength={40} value={f.name} onChange={set('name')} placeholder="e.g. Shop supervisor" /></Field>
      <Field label="Description"><Input maxLength={200} value={f.summary} onChange={set('summary')} /></Field>
      <Field label="Sees" hint="A store or dealer role sees only that store’s or dealer’s records; the user is bound to one when created."><Select value={f.scope} onChange={set('scope')}><option value="staff">All records</option><option value="store">Only their own store</option><option value="dealer">Only their own dealer</option></Select></Field>
      <Field label="Starts on"><Select value={f.home} onChange={set('home')}><option value="/">Overview</option>{landing.filter((m) => m.href !== '/').map((m) => <option key={m.href} value={m.href}>{m.label}</option>)}</Select></Field>
      <Field label="Start from" hint="Copies that role’s permissions to tick off afterwards."><Select value={f.copyFrom} onChange={set('copyFrom')}><option value="">Nothing (no permissions yet)</option>{roles.map((r) => { const no = !su && r.grantsSuperuser; return <option key={r.id} value={r.id} disabled={no}>{r.label}{no ? ' (only the super user can copy this)' : ''}</option>; })}</Select></Field>
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2"><Button type="submit" disabled={busy || f.name.trim().length < 2}>{busy ? 'Creating…' : 'Create role'}</Button><Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Editor({ role, roles, setSel, catalogue, landing, top, onChanged, onDeleted }: { role: RoleView; roles: RoleView[]; setSel: (id: string) => void; catalogue: PermInfo[]; landing: Array<{ href: string; label: string }>; top: React.ReactNode; onChanged: () => void; onDeleted: () => void }) {
  const su = !!useAuth().me?.isSuperuser;
  const frozen = !su && role.grantsSuperuser;   // the server refuses every change to a role that gives Settings or Integration unless the super user makes it
  const locked = (p: PermInfo) => p.superuserGrant && !su;
  const [perms, setPerms] = useState<string[]>(role.permissions);
  const [credit, setCredit] = useState<string>(role.creditLimitMinor === null ? '' : role.creditLimitMinor ? String(role.creditLimitMinor / 100) : '0');
  const [unlimited, setUnlimited] = useState(role.creditLimitMinor === null);
  const [name, setName] = useState(role.label);
  const [summary, setSummary] = useState(role.summary);
  const [scope, setScope] = useState(role.scope);
  const [home, setHome] = useState(role.home);
  const save = useAction(onChanged);
  const remove = useAction(onDeleted);
  const other = useAction(onChanged);
  const groups = useMemo(() => { const m = new Map<string, PermInfo[]>(); for (const p of catalogue) m.set(p.group, [...(m.get(p.group) ?? []), p]); return [...m.entries()]; }, [catalogue]);
  const creditMinor = unlimited ? null : Math.round((Number(credit) || 0) * 100);
  const creditDirty = perms.includes('billing:credit') && creditMinor !== (role.creditLimitMinor ?? 0);
  const detailsDirty = role.custom && (name !== role.label || summary !== role.summary || scope !== role.scope || home !== role.home);
  const dirty = !same(perms, role.permissions) || creditDirty || detailsDirty;
  const added = perms.filter((p) => !role.defaults.includes(p)).length, removed = role.defaults.filter((p) => !perms.includes(p)).length;
  const toggle = (id: string) => setPerms(perms.includes(id) ? perms.filter((p) => p !== id) : [...perms, id]);
  const setGroup = (items: PermInfo[], on: boolean) => setPerms(on ? [...new Set([...perms, ...items.filter((i) => !locked(i)).map((i) => i.id)])] : perms.filter((p) => !items.some((i) => i.id === p && !locked(i))));
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <nav aria-label="Roles" className="space-y-1">
        {top}
        {roles.map((r) => (
          <button key={r.id} type="button" onClick={() => setSel(r.id)} aria-current={r.id === role.id} className={`flex min-h-tap w-full items-center justify-between gap-2 rounded-control px-3 py-2 text-left text-subhead ${r.id === role.id ? 'bg-accent/10 font-medium text-accent' : 'hover:bg-surface2'}`}>
            <span>{r.label}{r.disabled && <span className="ml-1.5 text-caption text-label2">off</span>}</span>
            <span className="flex items-center gap-1">{r.custom && <span className="text-caption text-label2">custom</span>}{r.customised && <span className="h-2 w-2 rounded-full bg-accent" title="Changed from the default" />}<span className="text-caption text-label2">{r.users}</span></span>
          </button>
        ))}
        <p className="px-3 pt-2 text-caption text-label2">The number is how many active users hold the role. A dot means its permissions differ from the default.</p>
      </nav>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          {role.custom ? (
            <div className="grid flex-1 gap-3 sm:grid-cols-2">
              <Field label="Role name"><Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Description"><Input value={summary} maxLength={200} onChange={(e) => setSummary(e.target.value)} /></Field>
              <Field label="Sees" hint={role.users ? 'Fixed while users hold the role' : undefined}><Select value={scope} disabled={role.users > 0} onChange={(e) => setScope(e.target.value)}><option value="staff">All records</option><option value="store">Only their own store</option><option value="dealer">Only their own dealer</option></Select></Field>
              <Field label="Starts on"><Select value={home} onChange={(e) => setHome(e.target.value)}><option value="/">Overview</option>{landing.filter((m) => m.href !== '/').map((m) => <option key={m.href} value={m.href}>{m.label}</option>)}</Select></Field>
            </div>
          ) : (
            <div><h3 className="text-title3 font-semibold">{role.label}</h3><p className="mt-1 text-subhead text-label2">{role.summary}</p></div>
          )}
          <div className="flex gap-1">{!role.custom && <Badge>{role.scope === 'staff' ? 'Sees all records' : `Sees own ${role.scope} only`}</Badge>}{role.custom && <Badge tone="success">Custom role</Badge>}{role.customised && <Badge tone="warning">Changed</Badge>}</div>
        </div>
        <p className="mt-3 text-footnote text-label2">{role.users} active {role.users === 1 ? 'user holds' : 'users hold'} this role. Changes apply to them on their next action. Which records the role can see is fixed by its scope; here you choose what it can do with them.</p>
        <div className="mt-4 space-y-5">
          {groups.map(([group, items]) => {
            const on = items.filter((i) => perms.includes(i.id)).length;
            const free = items.filter((i) => !locked(i)), freeOn = free.filter((i) => perms.includes(i.id)).length;
            return (
              <fieldset key={group}>
                <legend className="mb-1 flex w-full items-center justify-between text-subhead font-semibold"><span>{group} <span className="font-normal text-label2">({on}/{items.length})</span></span>
                  {free.length > 0 && <button type="button" disabled={frozen} className="text-footnote font-normal text-accent disabled:opacity-50" onClick={() => setGroup(items, freeOn < free.length)}>{freeOn < free.length ? 'Select all' : 'Clear'}</button>}</legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {items.map((p) => (
                    <label key={p.id} className={`flex min-h-tap items-start gap-3 rounded-control bg-surface2 p-2.5 ${locked(p) || frozen ? 'opacity-60' : 'cursor-pointer'}`}>
                      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" disabled={locked(p) || frozen} aria-describedby={locked(p) ? `su-${p.id}` : undefined} checked={perms.includes(p.id)} onChange={() => toggle(p.id)} />
                      <span><span className="font-medium">{p.label}</span>{locked(p) && <span id={`su-${p.id}`} className="ml-2 text-caption text-label2">Only the super user can give this</span>}{role.defaults.includes(p.id) !== perms.includes(p.id) && <span className="ml-2 text-caption text-accent">{perms.includes(p.id) ? 'added' : 'removed'}</span>}<span className="block text-footnote text-label2">{p.hint}</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
        </div>
        {perms.includes('billing:credit') && (
          <div className="mt-5 max-w-sm">
            <Field label="Largest single credit note" hint={role.defaultCreditLimitMinor === null ? 'Default: unlimited' : `Default: ${money(role.defaultCreditLimitMinor ?? 0)}`}>
              <div className="flex items-center gap-3"><Input type="number" min={0} step="0.01" disabled={unlimited} value={unlimited ? '' : credit} onChange={(e) => setCredit(e.target.value)} />
                <label className="flex items-center gap-2 whitespace-nowrap text-subhead"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />No limit</label></div>
            </Field>
          </div>
        )}
        {role.modules.length > 0 && <p className="mt-4 text-footnote text-label2">Saved access opens: {role.modules.join(' · ')}.</p>}
        {frozen && <div className="mt-3"><Alert tone="info">This role gives Settings or Integration, so only the super user can change, clone, switch off or delete it.</Alert></div>}
        {role.disabled && <div className="mt-3"><Alert tone="info">This role is switched off: it grants nothing right now.</Alert></div>}
        {(save.error || remove.error || other.error) && <div className="mt-3"><Alert>{save.error || remove.error || other.error}</Alert></div>}{other.ok && <div className="mt-3"><Alert tone="success">{other.ok}</Alert></div>}{save.ok && !dirty && <div className="mt-3"><Alert tone="success">{save.ok}</Alert></div>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button disabled={!dirty || save.busy || frozen} onClick={() => save.run(() => patch(`/roles/${role.id}`, { ...(role.custom ? { name, summary, scope, home } : {}), permissions: perms, ...(perms.includes('billing:credit') ? { creditLimitMinor: creditMinor } : {}) }), 'Saved')}>{save.busy ? 'Saving…' : 'Save changes'}</Button>
          {dirty && <Button variant="secondary" onClick={() => { setPerms(role.permissions); setCredit(role.creditLimitMinor === null ? '' : String((role.creditLimitMinor ?? 0) / 100)); setUnlimited(role.creditLimitMinor === null); setName(role.label); setSummary(role.summary); setScope(role.scope); setHome(role.home); }}>Discard</Button>}
          {role.customised && <Button variant="plain" disabled={save.busy || frozen} onClick={() => { if (confirm(`Put ${role.label} back to its default permissions?`)) void save.run(() => post(`/roles/${role.id}/reset`), 'Back to the default'); }}>Reset to default</Button>}
          <Button variant="plain" disabled={other.busy || frozen} onClick={() => { const n = prompt(`Name for the copy of ${role.label}`, `Copy of ${role.label}`); if (n?.trim()) void other.run(async () => { const r = await post('/roles', { name: n.trim(), copyFrom: role.id, scope: role.scope === 'customer' ? 'staff' : role.scope, home: role.home }); setSel(r.id); }, 'Copied. Adjust the copy and save.'); }}>Clone</Button>
          {role.id !== 'admin' && <Button variant="plain" disabled={other.busy || frozen} onClick={() => { if (role.disabled || confirm(`Switch off ${role.label}? Its ${role.users} user(s) keep the role but get nothing from it until you switch it back on.`)) void other.run(() => post(`/roles/${role.id}/disable`, { disabled: !role.disabled }), role.disabled ? 'Switched on' : 'Switched off'); }}>{role.disabled ? 'Switch on' : 'Switch off'}</Button>}
          {role.custom && <Button variant="plain" disabled={remove.busy || frozen} onClick={() => { if (confirm(`Delete the role ${role.label}?`)) void remove.run(() => del(`/roles/${role.id}`)); }}>Delete role</Button>}
          {!role.custom && <span className="text-footnote text-label2">{added + removed > 0 ? `Compared with the default: ${added} added, ${removed} removed` : 'Same as the default'}</span>}
        </div>
      </Card>
    </div>
  );
}
