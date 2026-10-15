'use client';
import { Badge, Field, Select } from '@meridian/ui';
import { useState } from 'react';
import { label, tone } from '@/lib/format';

const sev = (s: string) => label(s);
export const sevTone = (s: string) => (s === 'CRITICAL_OUTAGE' ? 'danger' : s === 'MAJOR_DEGRADATION' ? 'warning' : 'neutral') as 'danger' | 'warning' | 'neutral';

/** The severity and status of a case, side by side. */
export function CaseBadges({ c }: { c: any }) {
  return <span className="flex flex-wrap items-center gap-1"><Badge tone={tone(c.status)}>{label(c.status)}</Badge><Badge tone={sevTone(c.severity)}>{sev(c.severity)}</Badge></span>;
}

const mins = (m: number | null) => (m === null ? '' : Math.abs(m) >= 2880 ? `${Math.round(Math.abs(m) / 1440)}d` : Math.abs(m) >= 120 ? `${Math.round(Math.abs(m) / 60)}h` : `${Math.abs(m)}m`);
/** Where a case stands against its resolution SLA: time left, or how late. */
export function SlaPill({ sla }: { sla: any }) {
  if (!sla || sla.resolution.state === 'NONE') return <span className="text-label2">—</span>;
  const r = sla.resolution;
  const map: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
    OK: [`${mins(r.remainingMinutes)} left`, 'success'], WARNING: [`${mins(r.remainingMinutes)} left`, 'warning'], BREACHED: [`${mins(r.remainingMinutes)} late`, 'danger'],
    PAUSED: ['Paused', 'neutral'], MET: ['Met', 'success'], MISSED: ['Missed', 'danger'],
  };
  const [text, t] = map[r.state] ?? ['—', 'neutral'];
  return <Badge tone={t}>{text}</Badge>;
}

/** Category → sub-category → issue type, three selects that narrow each other. */
export function IssueTypePicker({ tree, value, onChange }: { tree: any[]; value: string; onChange: (id: string) => void }) {
  const path = (id: string) => { const out: string[] = []; const walk = (nodes: any[], trail: string[]): boolean => { for (const n of nodes) { const t = [...trail, n.id]; if (n.id === id) { out.push(...t); return true; } if (n.children && walk(n.children, t)) return true; } return false; }; walk(tree, []); return out; };
  const [sel, setSel] = useState<string[]>(value ? path(value) : []);
  const cat = tree.find((n) => n.id === sel[0]), sub = cat?.children.find((n: any) => n.id === sel[1]);
  const pick = (level: number, id: string) => { const next = [...sel.slice(0, level), id].filter(Boolean); setSel(next); onChange(level === 2 ? id : ''); };
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Category"><Select value={sel[0] ?? ''} onChange={(e) => pick(0, e.target.value)}><option value="">Choose…</option>{tree.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</Select></Field>
      <Field label="Sub-category"><Select value={sel[1] ?? ''} disabled={!cat} onChange={(e) => pick(1, e.target.value)}><option value="">Choose…</option>{cat?.children.map((n: any) => <option key={n.id} value={n.id}>{n.name}</option>)}</Select></Field>
      <Field label="Issue"><Select value={sel[2] ?? ''} disabled={!sub} onChange={(e) => pick(2, e.target.value)}><option value="">Choose…</option>{sub?.children.map((n: any) => <option key={n.id} value={n.id}>{n.name}</option>)}</Select></Field>
    </div>
  );
}
