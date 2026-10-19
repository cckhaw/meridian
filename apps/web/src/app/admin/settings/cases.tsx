'use client';
import { Alert, Badge, Button, Card, Field, Input, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { label, step, toInput, toMinor } from '@/lib/format';

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
      <Incidents />
      <FieldService />
      <RefundTiers />
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
      <p className="-mt-2 mb-3 text-subhead text-label2">How long a case may wait for a first response and for a resolution, by customer tier and severity. Times are in minutes. When the "Warn at %" share of the resolution time has passed, supervisors are alerted; when all of it has passed, the case is breached and escalated. Changes apply to cases opened from now on.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-subhead"><thead><tr className="text-label2"><th className="py-2 pr-3 font-medium">Tier</th><th className="py-2 pr-3 font-medium">Severity</th><th className="py-2 pr-3 font-medium">First response (min)</th><th className="py-2 pr-3 font-medium">Resolution (min)</th><th className="py-2 font-medium">Warn at %</th></tr></thead>
        <tbody>{TIERS.flatMap((t) => SEVERITIES.map((s) => data.items.find((r) => r.tier === t && r.severity === s)).filter(Boolean)).map((r: any) => (
          <tr key={key(r)} className="border-t border-separator">
            <td className="py-2 pr-3">{label(r.tier)}</td><td className="py-2 pr-3">{label(r.severity)}</td>
            <td className="py-2 pr-3"><Input aria-label={`${r.tier} ${r.severity} first response`} type="number" min={1} className="!min-h-[36px] max-lg:!min-h-tap w-28" value={val(r).fr} onChange={(e) => set(r, 'fr', e.target.value)} /><span className="ml-2 text-caption text-label2">{human(Number(val(r).fr) || 0)}</span></td>
            <td className="py-2 pr-3"><Input aria-label={`${r.tier} ${r.severity} resolution`} type="number" min={1} className="!min-h-[36px] max-lg:!min-h-tap w-28" value={val(r).res} onChange={(e) => set(r, 'res', e.target.value)} /><span className="ml-2 text-caption text-label2">{human(Number(val(r).res) || 0)}</span></td>
            <td className="py-2"><Input aria-label={`${r.tier} ${r.severity} warning`} type="number" min={1} max={99} className="!min-h-[36px] max-lg:!min-h-tap w-20" value={val(r).warn} onChange={(e) => set(r, 'warn', e.target.value)} /></td></tr>))}</tbody></table></div>
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

function Incidents() {
  const { data, error, reload } = useApi<any>('/settings/cases');
  const act = useAction(reload);
  const [v, setV] = useState<Record<string, any>>({});
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const cur = { incidentAutoLink: v.incidentAutoLink ?? data.incidentAutoLink, incidentAutoCreate: v.incidentAutoCreate ?? data.incidentAutoCreate, incidentThreshold: v.incidentThreshold ?? String(data.incidentThreshold), incidentWindowMinutes: v.incidentWindowMinutes ?? String(data.incidentWindowMinutes) };
  return (
    <Card>
      <SectionTitle>Network incidents</SectionTitle>
      <p className="-mt-2 mb-3 text-subhead text-label2">When a node fails, many customers report it. A master incident stands for the fault; each customer&apos;s case hangs from it, and resolving the incident resolves them all and tells each customer.</p>
      <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={cur.incidentAutoLink} onChange={(e) => setV({ ...v, incidentAutoLink: e.target.checked })} /><span>A new fault case at a node with an open incident joins it</span></label>
      <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={cur.incidentAutoCreate} onChange={(e) => setV({ ...v, incidentAutoCreate: e.target.checked })} /><span>Open an incident by itself when several fault cases come from one node</span></label>
      {cur.incidentAutoCreate && <div className="mt-2 grid max-w-md gap-3 sm:grid-cols-2"><Field label="Number of cases"><Input type="number" min={2} value={cur.incidentThreshold} onChange={(e) => setV({ ...v, incidentThreshold: e.target.value })} /></Field><Field label="Within (minutes)"><Input type="number" min={1} value={cur.incidentWindowMinutes} onChange={(e) => setV({ ...v, incidentWindowMinutes: e.target.value })} /></Field></div>}
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}{act.ok && !Object.keys(v).length && <div className="mt-3"><Alert tone="success">{act.ok}</Alert></div>}
      <div className="mt-4"><Button disabled={act.busy || !Object.keys(v).length} onClick={async () => { if (await act.run(() => post('/settings/cases', { incidentAutoLink: cur.incidentAutoLink, incidentAutoCreate: cur.incidentAutoCreate, incidentThreshold: Number(cur.incidentThreshold), incidentWindowMinutes: Number(cur.incidentWindowMinutes) }), 'Saved')) setV({}); }}>Save</Button></div>
    </Card>
  );
}

function RefundTiers() {
  const { data, error, reload } = useApi<{ items: any[]; roles: Array<{ id: string; label: string }> }>('/settings/cases/refund-tiers');
  const act = useAction(reload);
  const [rows, setRows] = useState<Array<{ label: string; max: string; roles: string }> | null>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const cur = rows ?? data.items.map((t) => ({ label: t.label, max: t.maxMinor === null ? '' : toInput(t.maxMinor), roles: t.roleIds.join(', ') }));
  const set = (i: number, k: 'label' | 'max' | 'roles', val: string) => setRows(cur.map((r, j) => (j === i ? { ...r, [k]: val } : r)));
  const body = () => ({ tiers: cur.map((r, i) => ({ label: r.label, maxMinor: i === cur.length - 1 ? null : toMinor(r.max || '0'), roleIds: r.roles.split(/[,\s]+/).map((x: string) => x.trim()).filter(Boolean) })) });
  return (
    <Card>
      <SectionTitle>Refund approval</SectionTitle>
      <p className="-mt-2 mb-3 text-subhead text-label2">A refund on a billing dispute is approved by the lowest tier whose limit covers it. Someone in a tier can approve up to that tier&apos;s limit, and anything below. A refund within the asker&apos;s own limit is credited at once; otherwise someone else in a high enough tier must approve it. The top tier has no limit.</p>
      <div className="space-y-3">{cur.map((r, i) => (
        <div key={i} className="grid gap-3 rounded-control bg-surface2 p-3 sm:grid-cols-[1fr_9rem_2fr]">
          <Field label="Tier"><Input value={r.label} onChange={(e) => set(i, 'label', e.target.value)} maxLength={40} /></Field>
          <Field label="Up to">{i === cur.length - 1 ? <Input value="No limit" disabled /> : <Input type="number" min="0" step={step()} value={r.max} onChange={(e) => set(i, 'max', e.target.value)} />}</Field>
          <Field label="Roles" hint={i === 0 ? `Role ids: ${data.roles.map((x) => x.id).join(', ')}` : undefined}><Input value={r.roles} onChange={(e) => set(i, 'roles', e.target.value)} className="font-mono" /></Field>
        </div>))}</div>
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}{act.ok && !rows && <div className="mt-3"><Alert tone="success">{act.ok}</Alert></div>}
      <div className="mt-4"><Button disabled={act.busy || !rows} onClick={async () => { if (await act.run(() => post('/settings/cases/refund-tiers', body()), 'Saved')) setRows(null); }}>Save approval tiers</Button></div>
    </Card>
  );
}

function FieldService() {
  const ov = useApi<any>('/settings/cases/field-service');
  const cs = useApi<any>('/settings/cases');
  const act = useAction(async () => { await ov.reload(); await cs.reload(); });
  const [vendor, setVendor] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [bookAt, setBookAt] = useState<boolean | null>(null);
  const [cfg, setCfg] = useState<Record<string, any>>({});
  const [secretEnv, setSecretEnv] = useState<string | null>(null);
  const [v, setV] = useState<Record<string, any>>({});
  const [test, setTest] = useState<any>(null);
  if (ov.error) return <Alert>{ov.error}</Alert>;
  if (!ov.data || !cs.data) return <Spinner />;
  const o = ov.data, vid = vendor ?? o.vendor ?? '', on = enabled ?? o.enabled, bookOn = bookAt ?? !!o.bookAtOrder;
  const vend = o.vendors.find((x: any) => x.id === vid);
  const conf = { ...(vend?.config ?? {}), ...cfg };
  const dirtyConn = vendor !== null || enabled !== null || bookAt !== null || Object.keys(cfg).length > 0 || secretEnv !== null;
  const cur = { dispatchGraceMinutes: v.dispatchGraceMinutes ?? String(cs.data.dispatchGraceMinutes), dispatchUnconfirmedHours: v.dispatchUnconfirmedHours ?? String(cs.data.dispatchUnconfirmedHours), autoDispatch: v.autoDispatch ?? cs.data.autoDispatch };
  return (
    <Card>
      <SectionTitle>Field service (technician visits)</SectionTitle>
      <p className="-mt-2 mb-3 text-subhead text-label2">Connect your workforce-management system so agents can book technician visits from a case. The system reports progress to the callback address below, and the case follows it.</p>
      <div className="grid max-w-xl gap-3">
        <Field label="System"><Select value={vid} onChange={(e) => { setVendor(e.target.value); setCfg({}); }}><option value="">None</option>{o.vendors.map((x: any) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
        {vend && <p className="text-footnote text-label2">{vend.summary}</p>}
        {vend?.fields.map((f: any) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            {f.kind === 'select' ? <Select value={String(conf[f.key] ?? '')} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })}>{f.options.map((op: any) => <option key={op.value} value={op.value}>{op.label}</option>)}</Select>
              : <Input type={f.kind === 'number' ? 'number' : 'text'} value={String(conf[f.key] ?? '')} placeholder={f.placeholder} className={f.kind === 'env' ? 'font-mono' : ''} onChange={(e) => setCfg({ ...cfg, [f.key]: f.kind === 'number' ? Number(e.target.value) : e.target.value })} />}
          </Field>))}
        <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={on} onChange={(e) => setEnabled(e.target.checked)} /><span>Switched on</span></label>
        <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={bookOn} onChange={(e) => setBookAt(e.target.checked)} /><span>Let the customer pick the installation time while the order is taken<span className="block text-footnote text-label2">The new-order screen asks the field-service system for free times at the installation address; the chosen time is held, and booked once the order is paid. It can be moved later from the installation case. Off: only a preferred date is noted.</span></span></label>
        <Field label="Callback address" hint="Give this to the field-service system. It signs each call with the secret below.">
          <Input readOnly value={`${typeof window === 'undefined' ? '' : window.location.origin}${o.callbackPath}`} className="font-mono" onFocus={(e) => e.currentTarget.select()} /></Field>
        <Field label="Callback secret (environment variable)" hint={o.webhookSecretSet && secretEnv === null ? `Set on the server. Signatures are checked with ${o.webhookSecretEnv}.` : `Not set on the server yet: add ${secretEnv ?? o.webhookSecretEnv} (16 characters or more), or callbacks are refused.`}>
          <Input value={secretEnv ?? o.webhookSecretEnv} onChange={(e) => setSecretEnv(e.target.value)} className="font-mono" /></Field>
        {o.problem && <Alert tone="info">{o.problem}</Alert>}
        {test && <Alert tone={test.ok ? 'success' : 'danger'}>{test.detail}</Alert>}
        {act.error && <Alert>{act.error}</Alert>}{act.ok && !dirtyConn && <Alert tone="success">{act.ok}</Alert>}
        <div className="flex gap-2">
          <Button disabled={act.busy || !dirtyConn} onClick={async () => { if (await act.run(() => post('/settings/cases/field-service', { vendor: vid || null, enabled: on && !!vid, bookAtOrder: bookOn, config: vid ? conf : undefined, ...(secretEnv !== null ? { webhookSecretEnv: secretEnv } : {}) }), 'Saved')) { setVendor(null); setEnabled(null); setBookAt(null); setCfg({}); setSecretEnv(null); } }}>Save</Button>
          <Button variant="secondary" disabled={act.busy || !o.vendor} onClick={async () => setTest(await act.run(() => post('/settings/cases/field-service/test')))}>Test the connection</Button>
        </div>
      </div>
      <h3 className="mb-2 mt-6 text-subhead font-semibold">Visits and escalation</h3>
      <div className="grid max-w-xl gap-3 sm:grid-cols-2">
        <Field label="Tell supervisors when the technician has not reported, after (minutes past the window)"><Input type="number" min={1} value={cur.dispatchGraceMinutes} onChange={(e) => setV({ ...v, dispatchGraceMinutes: e.target.value })} /></Field>
        <Field label="…or when the booking is not confirmed within (hours)"><Input type="number" min={1} value={cur.dispatchUnconfirmedHours} onChange={(e) => setV({ ...v, dispatchUnconfirmedHours: e.target.value })} /></Field>
      </div>
      <label className="mt-2 flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={cur.autoDispatch} onChange={(e) => setV({ ...v, autoDispatch: e.target.checked })} /><span>When a fault that needs a technician breaches its SLA, book the earliest slot by itself</span></label>
      <div className="mt-3"><Button disabled={act.busy || !Object.keys(v).length} onClick={async () => { if (await act.run(() => post('/settings/cases', { dispatchGraceMinutes: Number(cur.dispatchGraceMinutes), dispatchUnconfirmedHours: Number(cur.dispatchUnconfirmedHours), autoDispatch: cur.autoDispatch }), 'Saved')) setV({}); }}>Save</Button></div>
    </Card>
  );
}
