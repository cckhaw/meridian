'use client';
import { Combobox, MultiCombobox, type ComboOption } from '@meridian/ui';
import { api, ApiError } from '@/lib/api';
import { d } from '@/lib/format';

export interface Officer { username: string; displayName: string; roles: string[]; open: number; overdue: number; away: boolean; awayUntil: string | null; capacityLeft: number | null; eligible: boolean; notEligibleReason: string | null; isSuperuser?: boolean }

/**
 * Everyone listed here holds the KYC review permission, so anyone can be given a case by hand. An officer who automatic distribution would skip (away, at the open-case limit,
 * or the super user) stays selectable and shows why as a warning; assigning to an away officer asks for a confirmation (see `isAwayConfirm`).
 */
export const officerOption = (o: Officer): ComboOption => ({
  value: o.username,
  label: o.displayName || o.username,
  description: [o.roles.join(', ') || null, o.overdue > 0 ? `${o.overdue} overdue` : null].filter(Boolean).join(' · '),
  detail: `${o.open} open`,
  warning: o.eligible ? undefined : `${o.notEligibleReason ?? 'Not given cases automatically'}${o.away || o.isSuperuser ? '' : ' (assigning by hand ignores the limit)'}`,
});

/** The server asks for a confirmation before a case goes to an officer who is away ("Siti is away until 2026-11-20. Confirm to assign anyway."). */
export const isAwayConfirm = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 422 && /Confirm to assign anyway/.test(e.message);
/** The question to show for that answer: the server's sentence with the instruction turned into a question. */
export const awayQuestion = (e: ApiError) => `${e.message.replace(/\s*Confirm to assign anyway\.?\s*$/, '')} Assign anyway?`;

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
