'use client';
import { Combobox, MultiCombobox, type ComboOption } from '@meridian/ui';
import { api } from '@/lib/api';
import { d } from '@/lib/format';

export interface Officer { username: string; displayName: string; roles: string[]; open: number; overdue: number; away: boolean; awayUntil: string | null; capacityLeft: number | null; eligible: boolean; notEligibleReason: string | null }

export const officerOption = (o: Officer): ComboOption => ({
  value: o.username,
  label: o.displayName || o.username,
  description: [o.away ? `Away${o.awayUntil ? ` until ${d(o.awayUntil)}` : ''}` : null, o.roles.join(', ') || null, o.overdue > 0 ? `${o.overdue} overdue` : null].filter(Boolean).join(' · '),
  detail: `${o.open} open`,
  disabled: !o.eligible,
  disabledReason: o.notEligibleReason ?? 'Cannot take cases right now',
});

/** Type-ahead source for the officer pickers. The server matches the text against name and username (`*` and `?` work). Module level so its identity is stable. */
export async function loadOfficers(q: string): Promise<ComboOption[]> {
  const r = await api<{ items: Officer[] }>(`/kyc/officers?limit=50${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`);
  return r.items.map(officerOption);
}

/** Pick one officer from everyone allowed to review. Needs the kyc:assign permission (the list is refused otherwise). */
export function OfficerPicker({ value, valueLabel, onChange, label = 'Officer', placeholder = 'Search officers…', id, clearable = true }: { value: string | null; valueLabel?: string; onChange: (username: string | null, name?: string) => void; label?: string; placeholder?: string; id?: string; clearable?: boolean }) {
  return <Combobox id={id} label={label} placeholder={placeholder} load={loadOfficers} value={value} valueLabel={valueLabel} clearable={clearable} emptyText="No officer matches" onChange={(v, o) => onChange(v, o?.label)} />;
}
export function OfficerMultiPicker({ value, onChange, label = 'Officers', placeholder = 'Search officers…', disabled }: { value: string[]; onChange: (usernames: string[]) => void; label?: string; placeholder?: string; disabled?: boolean }) {
  return <MultiCombobox label={label} placeholder={placeholder} load={loadOfficers} value={value} disabled={disabled} emptyText="No officer matches" onChange={(v) => onChange(v)} />;
}
