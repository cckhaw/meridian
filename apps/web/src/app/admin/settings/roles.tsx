'use client';
import { Alert, Badge, Card, SearchField, Segmented, Spinner } from '@meridian/ui';
import { useMemo, useState } from 'react';
import { patch, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { RolesEditor, type RoleView } from './roles-editor';

interface Perm { id: string; key: string; domain: string; group: string; label: string; hint: string; superuserGrant: boolean }

/**
 * Roles and permissions, two ways to the same thing. The matrix shows every role against every permission, grouped by domain: tick a box, or drag
 * a permission onto a role to give it. The editor works one role at a time (scope, landing page, credit limit, clone, switch off, delete).
 * A change saves at once, applies to the people holding the role on their next request, and is audited.
 */
export function RolesSettings({ roles, reload }: { roles: RoleView[]; reload: () => void | Promise<void> }) {
  const [view, setView] = useState<'matrix' | 'role'>('matrix');
  return (
    <div className="space-y-5">
      <Segmented label="How to edit" value={view} options={[{ value: 'matrix', label: 'Matrix' }, { value: 'role', label: 'One role at a time' }]} onChange={setView} />
      {view === 'matrix' ? <Matrix roles={roles} reload={reload} /> : <RolesEditor roles={roles} onChanged={() => void reload()} />}
    </div>
  );
}

function Matrix({ roles, reload }: { roles: RoleView[]; reload: () => void | Promise<void> }) {
  const cat = useApi<{ permissions: Perm[] }>('/roles/permissions');
  const act = useAction(async () => { await reload(); });
  const su = !!useAuth().me?.isSuperuser;
  const [q, setQ] = useState('');
  const [over, setOver] = useState<string | null>(null);
  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const m = new Map<string, Perm[]>();
    for (const p of cat.data?.permissions ?? []) {
      if (words.length && !words.every((w) => `${p.label} ${p.key} ${p.id} ${p.hint} ${p.group}`.toLowerCase().includes(w))) continue;
      m.set(p.group, [...(m.get(p.group) ?? []), p]);
    }
    return [...m.entries()];
  }, [cat.data, q]);
  if (!cat.data) return <Spinner />;
  const grant = (role: RoleView, perm: string, on: boolean) => {
    if (!su && (role.grantsSuperuser || cat.data?.permissions.some((p) => p.id === perm && p.superuserGrant))) return;
    const next = on ? [...new Set([...role.permissions, perm])] : role.permissions.filter((x) => x !== perm);
    void act.run(() => patch(`/roles/${role.id}`, { permissions: next }), `${role.label}: ${on ? 'added' : 'removed'} ${perm}`);
  };
  const drop = (e: React.DragEvent, role: RoleView) => {
    e.preventDefault(); setOver(null);
    const p = e.dataTransfer.getData('text/permission');
    if (p && !role.permissions.includes(p)) grant(role, p, true);
  };
  return (
    <div className="space-y-3">
      <Card className="space-y-2">
        <p className="text-subhead text-label2">Tick a box to give or take away a permission, or <strong className="text-label">drag a permission from the left onto a role</strong> to give it. Each permission is named <code>domain:resource:action</code>. Changes save at once. Settings and Integration can be given to any role, but only the super user can give or take them away.</p>
        <SearchField label="Search permissions" placeholder="Search: refund, sim swap, billing:run…" value={q} onChange={setQ} />
      </Card>
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <div className="overflow-auto rounded-card bg-surface shadow-card" style={{ maxHeight: '70dvh' }}>
        <table className="min-w-full border-separate border-spacing-0 text-subhead">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 top-0 z-30 min-w-[15rem] border-b border-separator bg-surface px-3 py-2 text-left text-footnote font-semibold text-label2">Permission</th>
              {roles.map((r) => (
                <th key={r.id} scope="col" onDragOver={(e) => { e.preventDefault(); setOver(r.id); }} onDragLeave={() => setOver(null)} onDrop={(e) => drop(e, r)}
                  className={`sticky top-0 z-20 min-w-[7.5rem] border-b border-separator px-2 py-2 text-center align-bottom text-footnote font-medium ${over === r.id ? 'bg-accent/15' : 'bg-surface'} ${r.disabled ? 'opacity-60' : ''}`}>
                  <span className="block">{r.label}</span>
                  <span className="block font-mono text-caption font-normal text-label2">{r.code ?? 'custom'}</span>
                  {r.grantsSuperuser && !su && <span className="block text-caption font-normal text-label2">Only the super user can change this role</span>}
                  <span className="mt-0.5 flex flex-wrap items-center justify-center gap-1">{r.disabled && <Badge>Off</Badge>}<span className="text-caption font-normal text-label2">{r.users} user{r.users === 1 ? '' : 's'}</span></span>
                </th>))}
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && <tr><td colSpan={roles.length + 1} className="px-3 py-6 text-center text-label2">No permission matches “{q}”.</td></tr>}
            {groups.map(([g, items]) => (
              <GroupRows key={g} group={g} items={items} roles={roles} grant={grant} busy={act.busy} su={su} />))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({ group, items, roles, grant, busy, su }: { group: string; items: Perm[]; roles: RoleView[]; grant: (r: RoleView, p: string, on: boolean) => void; busy: boolean; su: boolean }) {
  return (
    <>
      <tr><th colSpan={roles.length + 1} scope="colgroup" className="sticky left-0 bg-surface2 px-3 py-1.5 text-left text-footnote font-semibold uppercase tracking-wide text-label2">{group}</th></tr>
      {items.map((p) => (
        <tr key={p.id} className="hover:bg-surface2">
          <th scope="row" draggable={!(p.superuserGrant && !su)} onDragStart={(e) => { e.dataTransfer.setData('text/permission', p.id); e.dataTransfer.effectAllowed = 'copy'; }}
            className="sticky left-0 z-10 border-b border-separator bg-surface px-3 py-2 text-left font-normal" style={{ cursor: p.superuserGrant && !su ? 'default' : 'grab' }}>
            <span className="block font-medium">{p.label}</span>
            <span className="block font-mono text-caption text-label2">{p.key}</span>
            {p.superuserGrant && !su && <span className="block text-caption text-label2">Only the super user can give this</span>}
          </th>
          {roles.map((r) => {
            const on = r.permissions.includes(p.id);
            return (
              <td key={r.id} className="border-b border-separator px-2 py-1 text-center">
                <label className="inline-flex min-h-tap min-w-tap items-center justify-center">
                  <input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={on} disabled={(!su && (p.superuserGrant || r.grantsSuperuser)) || busy} aria-label={`${r.label}: ${p.label}${!su && p.superuserGrant ? ' (only the super user can give this)' : !su && r.grantsSuperuser ? ' (only the super user can change this role)' : ''}`} onChange={(e) => grant(r, p.id, e.target.checked)} />
                </label>
              </td>);
          })}
        </tr>))}
    </>
  );
}
