'use client';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '@meridian/ui';
import { useMemo, useState } from 'react';
import { patch, post, useAction, useApi } from '@/lib/api';
import { money } from '@/lib/format';

interface RoleView { id: string; label: string; summary: string; scope: string; permissions: string[]; defaults: string[]; creditLimitMinor?: number | null; defaultCreditLimitMinor?: number | null; customised: boolean; users: number; modules: string[] }
interface PermInfo { id: string; group: string; label: string; hint: string; superuserOnly: boolean }

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Roles and permissions: pick a role, tick what it may do, save. "Reset to default" returns it to the built-in set. */
export function RolesEditor({ roles, onChanged }: { roles: RoleView[]; onChanged: () => void }) {
  const catalogue = useApi<PermInfo[]>('/roles/permissions');
  const [sel, setSel] = useState<string>('retail-store');
  const role = roles.find((r) => r.id === sel) ?? roles[0];
  if (!role) return <Spinner />;
  if (!catalogue.data) return <Spinner />;
  return <Editor key={role.id} role={role} roles={roles} setSel={setSel} catalogue={catalogue.data} onChanged={onChanged} />;
}

function Editor({ role, roles, setSel, catalogue, onChanged }: { role: RoleView; roles: RoleView[]; setSel: (id: string) => void; catalogue: PermInfo[]; onChanged: () => void }) {
  const [perms, setPerms] = useState<string[]>(role.permissions);
  const [credit, setCredit] = useState<string>(role.creditLimitMinor === null ? '' : role.creditLimitMinor ? String(role.creditLimitMinor / 100) : '0');
  const [unlimited, setUnlimited] = useState(role.creditLimitMinor === null);
  const save = useAction(onChanged);
  const groups = useMemo(() => { const m = new Map<string, PermInfo[]>(); for (const p of catalogue) m.set(p.group, [...(m.get(p.group) ?? []), p]); return [...m.entries()]; }, [catalogue]);
  const creditMinor = unlimited ? null : Math.round((Number(credit) || 0) * 100);
  const creditDirty = perms.includes('billing:credit') && creditMinor !== (role.creditLimitMinor ?? 0);
  const dirty = !same(perms, role.permissions) || creditDirty;
  const added = perms.filter((p) => !role.defaults.includes(p)).length, removed = role.defaults.filter((p) => !perms.includes(p)).length;
  const toggle = (id: string) => setPerms(perms.includes(id) ? perms.filter((p) => p !== id) : [...perms, id]);
  const setGroup = (items: PermInfo[], on: boolean) => setPerms(on ? [...new Set([...perms, ...items.filter((i) => !i.superuserOnly).map((i) => i.id)])] : perms.filter((p) => !items.some((i) => i.id === p)));
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <nav aria-label="Roles" className="space-y-1">
        {roles.map((r) => (
          <button key={r.id} type="button" onClick={() => setSel(r.id)} aria-current={r.id === role.id} className={`flex min-h-tap w-full items-center justify-between gap-2 rounded-control px-3 py-2 text-left text-subhead ${r.id === role.id ? 'bg-accent/10 font-medium text-accent' : 'hover:bg-surface2'}`}>
            <span>{r.label}</span>
            <span className="flex items-center gap-1">{r.customised && <span className="h-2 w-2 rounded-full bg-accent" title="Changed from the default" />}<span className="text-caption text-label2">{r.users}</span></span>
          </button>
        ))}
        <p className="px-3 pt-2 text-caption text-label2">The number is how many active users hold the role. A dot means its permissions differ from the default.</p>
      </nav>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h3 className="text-title3 font-semibold">{role.label}</h3><p className="mt-1 text-subhead text-label2">{role.summary}</p></div>
          <div className="flex gap-1"><Badge>{role.scope === 'staff' ? 'Sees all records' : `Sees own ${role.scope} only`}</Badge>{role.customised && <Badge tone="warning">Changed</Badge>}</div>
        </div>
        <p className="mt-3 text-footnote text-label2">{role.users} active {role.users === 1 ? 'user holds' : 'users hold'} this role. Changes apply to them on their next action. Which records the role can see is fixed by its scope; here you choose what it can do with them.</p>
        <div className="mt-4 space-y-5">
          {groups.map(([group, items]) => {
            const on = items.filter((i) => perms.includes(i.id)).length;
            return (
              <fieldset key={group}>
                <legend className="mb-1 flex w-full items-center justify-between text-subhead font-semibold"><span>{group} <span className="font-normal text-label2">({on}/{items.length})</span></span>
                  <button type="button" className="text-footnote font-normal text-accent" onClick={() => setGroup(items, on < items.filter((i) => !i.superuserOnly).length)}>{on < items.filter((i) => !i.superuserOnly).length ? 'Select all' : 'Clear'}</button></legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {items.map((p) => (
                    <label key={p.id} className={`flex min-h-tap items-start gap-3 rounded-control bg-surface2 p-2.5 ${p.superuserOnly ? 'opacity-60' : 'cursor-pointer'}`}>
                      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" disabled={p.superuserOnly} checked={perms.includes(p.id)} onChange={() => toggle(p.id)} />
                      <span><span className="font-medium">{p.label}</span>{role.defaults.includes(p.id) !== perms.includes(p.id) && <span className="ml-2 text-caption text-accent">{perms.includes(p.id) ? 'added' : 'removed'}</span>}<span className="block text-footnote text-label2">{p.hint}</span></span>
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
        {save.error && <div className="mt-3"><Alert>{save.error}</Alert></div>}{save.ok && !dirty && <div className="mt-3"><Alert tone="success">{save.ok}</Alert></div>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button disabled={!dirty || save.busy} onClick={() => save.run(() => patch(`/roles/${role.id}`, { permissions: perms, ...(perms.includes('billing:credit') ? { creditLimitMinor: creditMinor } : {}) }), 'Saved')}>{save.busy ? 'Saving…' : 'Save changes'}</Button>
          {dirty && <Button variant="secondary" onClick={() => { setPerms(role.permissions); setCredit(role.creditLimitMinor === null ? '' : String((role.creditLimitMinor ?? 0) / 100)); setUnlimited(role.creditLimitMinor === null); }}>Discard</Button>}
          {role.customised && <Button variant="plain" disabled={save.busy} onClick={() => { if (confirm(`Put ${role.label} back to its default permissions?`)) void save.run(() => post(`/roles/${role.id}/reset`), 'Back to the default'); }}>Reset to default</Button>}
          <span className="text-footnote text-label2">{added + removed > 0 ? `Compared with the default: ${added} added, ${removed} removed` : 'Same as the default'}</span>
        </div>
      </Card>
    </div>
  );
}
