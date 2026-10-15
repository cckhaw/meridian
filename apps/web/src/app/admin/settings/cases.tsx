'use client';
import { Alert, Badge, Button, Card, Field, Input, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { label } from '@/lib/format';

const SEVERITIES = ['CRITICAL_OUTAGE', 'MAJOR_DEGRADATION', 'MINOR_INQUIRY'];
const TIERS = ['VIP', 'ENTERPRISE', 'STANDARD'];
const CASE_TYPES = ['FIBER_ASSURANCE', 'BILLING_REFUND', 'MNP_PORT_OUT', 'GENERAL'];
const human = (m: number) => (m % 1440 === 0 ? `${m / 1440} d` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);

/** Settings → Cases: the classification tree, the SLA matrix and the closing rules. */
export function CaseSettings() {
  return (
    <div className="space-y-6">
      <Taxonomy />
      <SlaMatrix />
      <Closing />
    </div>
  );
}

function Taxonomy() {
  const { data, error, reload } = useApi<{ items: any[] }>('/settings/cases/taxonomy');
  const act = useAction(reload);
  const [adding, setAdding] = useState<{ parentId: string | null; level: number } | null>(null);
  const [f, setF] = useState({ name: '', caseType: 'FIBER_ASSURANCE', defaultSeverity: 'MINOR_INQUIRY', needsDispatch: false, skills: '', equipment: '' });
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const codes = (s: string) => s.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  const add = async () => {
    const body: any = { name: f.name, parentId: adding!.parentId };
    if (adding!.level === 3) Object.assign(body, { caseType: f.caseType, defaultSeverity: f.defaultSeverity, needsDispatch: f.needsDispatch, skills: codes(f.skills), equipment: codes(f.equipment) });
    if (await act.run(() => post('/settings/cases/taxonomy', body), 'Added')) { setAdding(null); setF({ ...f, name: '', skills: '', equipment: '' }); }
  };
  const Node = ({ n }: { n: any }) => (
    <li className="mt-2">
      <div className={`flex flex-wrap items-center gap-2 rounded-control px-3 py-2 ${n.active ? 'bg-surface2' : 'bg-surface2 opacity-60'}`}>
        <span className={n.level === 1 ? 'font-semibold' : ''}>{n.name}</span>
        {n.level === 3 && <><Badge tone={n.defaultSeverity === 'CRITICAL_OUTAGE' ? 'danger' : n.defaultSeverity === 'MAJOR_DEGRADATION' ? 'warning' : 'neutral'}>{label(n.defaultSeverity)}</Badge><Badge>{label(n.caseType)}</Badge>{n.needsDispatch && <Badge tone="success">Field visit{n.skills.length ? `: ${n.skills.join(', ')}` : ''}</Badge>}</>}
        {!n.active && <Badge>Off</Badge>}
        <span className="ml-auto flex gap-1">
          {n.level < 3 && <button type="button" className="px-2 text-footnote text-accent" onClick={() => setAdding({ parentId: n.id, level: n.level + 1 })}>+ {n.level === 1 ? 'Sub-category' : 'Issue'}</button>}
          <button type="button" className="px-2 text-footnote text-accent" onClick={() => act.run(() => patch(`/settings/cases/taxonomy/${encodeURIComponent(n.id)}`, { active: !n.active }))}>{n.active ? 'Switch off' : 'Switch on'}</button>
          <button type="button" className="px-2 text-footnote text-danger" onClick={() => act.run(() => del(`/settings/cases/taxonomy/${encodeURIComponent(n.id)}`), 'Removed')}>Remove</button>
        </span>
      </div>
      {(n.children?.length > 0) && <ul className="ml-5 border-l border-separator pl-3">{n.children.map((c: any) => <Node key={c.id} n={c} />)}</ul>}
    </li>
  );
  return (
    <Card>
      <SectionTitle>Case classification</SectionTitle>
      <p className="-mt-2 mb-3 text-subhead text-label2">Every case is filed under a category, a sub-category and an issue. The issue decides the kind of case, how severe it usually is, and whether it normally needs a technician and which skills. An issue used by cases can be switched off but not removed.</p>
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <ul>{data.items.map((n) => <Node key={n.id} n={n} />)}</ul>
      <div className="mt-3"><Button variant="secondary" onClick={() => setAdding({ parentId: null, level: 1 })}>Add a category</Button></div>
      {adding && (
        <div className="mt-4 grid gap-3 rounded-card border border-separator p-4 sm:grid-cols-2">
          <h3 className="sm:col-span-2 text-subhead font-semibold">New {['', 'category', 'sub-category', 'issue'][adding.level]}{adding.parentId && <span className="font-normal text-label2"> under {adding.parentId}</span>}</h3>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} /></Field>
          {adding.level === 3 && <>
            <Field label="Kind of case"><Select value={f.caseType} onChange={(e) => setF({ ...f, caseType: e.target.value })}>{CASE_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
            <Field label="Usual severity"><Select value={f.defaultSeverity} onChange={(e) => setF({ ...f, defaultSeverity: e.target.value })}>{SEVERITIES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
            <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={f.needsDispatch} onChange={(e) => setF({ ...f, needsDispatch: e.target.checked })} /> Usually needs a technician visit</label>
            <Field label="Technician skills" hint="Codes in capitals, e.g. FIBER_SPLICING"><Input value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} className="font-mono" /></Field>
            <Field label="Equipment to reserve" hint="e.g. ONT_UNIT"><Input value={f.equipment} onChange={(e) => setF({ ...f, equipment: e.target.value })} className="font-mono" /></Field></>}
          <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !f.name.trim()} onClick={() => void add()}>Add</Button><Button variant="secondary" onClick={() => setAdding(null)}>Cancel</Button></div>
        </div>)}
    </Card>
  );
}

function SlaMatrix() {
  const { data, error, reload } = useApi<{ items: any[] }>('/settings/cases/sla');
  const act = useAction(reload);
  const [edit, setEdit] = useState<Record<string, { fr: string; res: string; warn: string }>>({});
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const key = (r: any) => `${r.tier}|${r.severity}`;
  const val = (r: any) => edit[key(r)] ?? { fr: String(r.firstResponseMinutes), res: String(r.resolutionMinutes), warn: String(r.warnPercent) };
  const set = (r: any, k: 'fr' | 'res' | 'warn', v: string) => setEdit({ ...edit, [key(r)]: { ...val(r), [k]: v } });
  const save = async () => { if (await act.run(() => post('/settings/cases/sla', { rows: data.items.filter((r) => edit[key(r)]).map((r) => { const v = val(r); return { tier: r.tier, severity: r.severity, firstResponseMinutes: Number(v.fr), resolutionMinutes: Number(v.res), warnPercent: Number(v.warn) }; }) }), 'Saved')) setEdit({}); };
  return (
    <Card>
      <SectionTitle>Service levels (SLA)</SectionTitle>
      <p className="-mt-2 mb-3 text-subhead text-label2">How long a case may wait for a first response and for a resolution, by customer tier and severity. Times are in minutes. When the resolution time passes the warning point, supervisors are alerted; past it, the case is breached. Changes apply to cases opened from now on.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-subhead"><thead><tr className="text-label2"><th className="py-2 pr-3 font-medium">Tier</th><th className="py-2 pr-3 font-medium">Severity</th><th className="py-2 pr-3 font-medium">First response (min)</th><th className="py-2 pr-3 font-medium">Resolution (min)</th><th className="py-2 font-medium">Warn at %</th></tr></thead>
        <tbody>{TIERS.flatMap((t) => SEVERITIES.map((s) => data.items.find((r) => r.tier === t && r.severity === s)).filter(Boolean)).map((r: any) => (
          <tr key={key(r)} className="border-t border-separator">
            <td className="py-2 pr-3">{label(r.tier)}</td><td className="py-2 pr-3">{label(r.severity)}</td>
            <td className="py-2 pr-3"><Input aria-label={`${r.tier} ${r.severity} first response`} type="number" min={1} className="!min-h-[36px] w-28" value={val(r).fr} onChange={(e) => set(r, 'fr', e.target.value)} /><span className="ml-2 text-caption text-label2">{human(Number(val(r).fr) || 0)}</span></td>
            <td className="py-2 pr-3"><Input aria-label={`${r.tier} ${r.severity} resolution`} type="number" min={1} className="!min-h-[36px] w-28" value={val(r).res} onChange={(e) => set(r, 'res', e.target.value)} /><span className="ml-2 text-caption text-label2">{human(Number(val(r).res) || 0)}</span></td>
            <td className="py-2"><Input aria-label={`${r.tier} ${r.severity} warning`} type="number" min={1} max={99} className="!min-h-[36px] w-20" value={val(r).warn} onChange={(e) => set(r, 'warn', e.target.value)} /></td></tr>))}</tbody></table></div>
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}{act.ok && !Object.keys(edit).length && <div className="mt-3"><Alert tone="success">{act.ok}</Alert></div>}
      <div className="mt-4"><Button disabled={act.busy || !Object.keys(edit).length} onClick={() => void save()}>Save service levels</Button></div>
    </Card>
  );
}

function Closing() {
  const { data, error, reload } = useApi<{ autoCloseHours: number; reopenDays: number; customerResponseHours: number }>('/settings/cases');
  const act = useAction(reload);
  const [v, setV] = useState<Record<string, string>>({});
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const cur = { autoCloseHours: v.autoCloseHours ?? String(data.autoCloseHours), reopenDays: v.reopenDays ?? String(data.reopenDays), customerResponseHours: v.customerResponseHours ?? String(data.customerResponseHours) };
  return (
    <Card>
      <SectionTitle>Closing and reopening</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="A resolved case closes itself after (hours)" hint="Unless the customer confirms sooner or reopens it."><Input type="number" min={1} value={cur.autoCloseHours} onChange={(e) => setV({ ...v, autoCloseHours: e.target.value })} /></Field>
        <Field label="A closed case can be reopened for (days)"><Input type="number" min={1} value={cur.reopenDays} onChange={(e) => setV({ ...v, reopenDays: e.target.value })} /></Field>
        <Field label="Waiting for the customer closes the case after (hours)" hint="When they never reply."><Input type="number" min={1} value={cur.customerResponseHours} onChange={(e) => setV({ ...v, customerResponseHours: e.target.value })} /></Field>
      </div>
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}{act.ok && !Object.keys(v).length && <div className="mt-3"><Alert tone="success">{act.ok}</Alert></div>}
      <div className="mt-4"><Button disabled={act.busy || !Object.keys(v).length} onClick={async () => { if (await act.run(() => post('/settings/cases', { autoCloseHours: Number(cur.autoCloseHours), reopenDays: Number(cur.reopenDays), customerResponseHours: Number(cur.customerResponseHours) }), 'Saved')) setV({}); }}>Save</Button></div>
    </Card>
  );
}
