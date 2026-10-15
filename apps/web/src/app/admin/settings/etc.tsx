'use client';
import { Alert, Badge, Button, Card, Field, Input, Modal, SectionTitle, Select, Spinner, Textarea } from '@meridian/ui';
import { useEffect, useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { label, money, step as moneyStep, toInput, toMinor } from '@/lib/format';
import { useSegments } from '@/lib/segments';

interface Rule { id?: string; code?: string; name: string; description: string; enabled: boolean; priority: number; scenarios: string[]; segments: string[]; device: 'ANY' | 'WITH_DEVICE' | 'NO_DEVICE'; vip: 'ANY' | 'YES' | 'NO';
  minTerm: number | null; maxTerm: number | null; minElapsed: number | null; maxElapsed: number | null; formula: string; minChargeMinor: number; maxChargeMinor: number | null; waiveLastMonths: number; deviceBalancePercent: number; applyVipMultiplier: boolean; version?: number }
interface View { rules: Rule[]; scenarios: Array<{ id: string; label: string }>; variables: Array<{ name: string; label: string; money: boolean; example: number }>; standard: Array<{ code: string; name: string }> }
const blank = (): Rule => ({ name: '', description: '', enabled: true, priority: 100, scenarios: ['CUSTOMER_REQUEST'], segments: [], device: 'ANY', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null,
  formula: 'monthlyFee * remaining * 0.5', minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 1, deviceBalancePercent: 100, applyVipMultiplier: true });
const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));

/** Settings → Early termination: what leaving a contract early costs, by scenario, worked out from a formula you write. */
export function EtcSettings() {
  const view = useApi<View>('/settings/etc');
  const act = useAction(async () => { await view.reload(); });
  const segs = useSegments();
  const [editing, setEditing] = useState<Rule | null>(null);
  if (view.error) return <Alert>{view.error}</Alert>;
  if (!view.data) return <Spinner />;
  const v = view.data;
  const scen = (id: string) => v.scenarios.find((s) => s.id === id)?.label ?? id;
  return (
    <div className="space-y-6">
      <Card>
        <p className="text-subhead text-label2">When a customer leaves a contract early, <strong className="text-label">the rule that fits the situation works out the charge</strong>. A rule says for which situations (scenarios), which customers and which contracts it applies, and gives a <strong className="text-label">formula</strong>: arithmetic over the contract’s figures such as the months left, the plan fee, the device subsidy and the unpaid device instalments. Of the rules that fit, the one with the highest priority is used. Unpaid <strong className="text-label">device instalments</strong> are collected on the final bill by the rule’s share. While no rule is switched on, the terms set on each offer decide, as before. If rules are on and none fits, the offer’s terms decide the charge and the unpaid instalments are collected in full.</p>
      </Card>
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <section aria-label="Rules">
        <SectionTitle action={<Button onClick={() => setEditing(blank())}>＋ New rule</Button>}>Rules</SectionTitle>
        {v.rules.length === 0 && (
          <Card>
            <p className="mb-3 text-subhead text-label2">No rules yet. Start from the standard set — {v.standard.map((s) => s.name).join('; ')} — then adjust the formulas to your terms.</p>
            <Button disabled={act.busy} onClick={() => void act.run(() => post('/settings/etc/standard'), 'Standard rules added')}>Add the standard rules</Button>
          </Card>)}
        <ul className="space-y-3">
          {v.rules.map((r) => (
            <li key={r.id}>
              <Card className={r.enabled ? '' : 'opacity-70'}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{r.name}</h3><Badge tone={r.enabled ? 'success' : 'neutral'}>{r.enabled ? 'On' : 'Off'}</Badge><span className="text-footnote text-label2">Priority {r.priority} · v{r.version}</span></div>
                    {r.description && <p className="mt-1 text-subhead text-label2">{r.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(r.scenarios.length ? r.scenarios : ['Any situation']).map((s) => <Badge key={s}>{s === 'Any situation' ? s : scen(s)}</Badge>)}
                      {r.device !== 'ANY' && <Badge>{r.device === 'WITH_DEVICE' ? 'With a device' : 'Plan only'}</Badge>}{r.vip !== 'ANY' && <Badge>{r.vip === 'YES' ? 'VIP' : 'Not VIP'}</Badge>}
                      {r.segments.length > 0 && <Badge>{r.segments.map(segs.name).join(', ')}</Badge>}
                    </div>
                    <p className="mt-2 rounded-control bg-surface2 px-3 py-2 font-mono text-footnote">{r.formula}</p>
                    <p className="mt-1 text-footnote text-label2">{r.waiveLastMonths > 0 ? `Free in the last ${r.waiveLastMonths} month${r.waiveLastMonths > 1 ? 's' : ''}. ` : ''}{r.maxChargeMinor !== null ? `At most ${money(r.maxChargeMinor)}. ` : ''}{r.minChargeMinor > 0 ? `At least ${money(r.minChargeMinor)}. ` : ''}Device instalments collected: {r.deviceBalancePercent}%.</p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => setEditing({ ...r })}>Edit</Button>
                    <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => patch(`/settings/etc/rules/${r.id}`, { ...r, enabled: !r.enabled }))}>{r.enabled ? 'Switch off' : 'Switch on'}</Button>
                  </div>
                </div>
              </Card>
            </li>))}
        </ul>
        {v.rules.length > 0 && <p className="mt-2 text-footnote text-label2"><button type="button" className="text-accent" onClick={() => void act.run(() => post('/settings/etc/standard'), 'Added any standard rules that were missing')}>Add the standard rules that are missing</button>. Rules you have already added or changed are kept.</p>}
      </section>
      <TryIt v={v} />
      {editing && <RuleEditor key={editing.id ?? 'new'} initial={editing} v={v} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await view.reload(); }} />}
    </div>
  );
}

function FormulaBox({ value, onChange, v }: { value: string; onChange: (s: string) => void; v: View }) {
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { void post('/settings/etc/check', { formula: value }).then((r) => setProblem(r.ok ? null : r.error)).catch(() => setProblem(null)); }, 350);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <div>
      <Field label="Formula" hint="Use + - * / % ( ) > < == && || ? : and min, max, round, floor, ceil, abs, clamp(x, lo, hi), pct(x, percent)." error={problem ?? undefined}>
        <Textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" spellCheck={false} />
      </Field>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {v.variables.map((x) => <button key={x.name} type="button" title={x.label} onClick={() => onChange(`${value}${value && !/[\s(]$/.test(value) ? ' ' : ''}${x.name}`)} className="rounded-control bg-surface2 px-2 py-1 font-mono text-footnote hover:bg-accent/10">{x.name}</button>)}
      </div>
      <ul className="mt-2 space-y-0.5 text-footnote text-label2">{v.variables.map((x) => <li key={x.name}><code>{x.name}</code>: {x.label}</li>)}</ul>
    </div>
  );
}

function RuleEditor({ initial, v, onClose, onSaved }: { initial: Rule; v: View; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const segs = useSegments();
  const act = useAction();
  const [r, setR] = useState<Rule>(initial);
  const upd = (p: Partial<Rule>) => setR((x) => ({ ...x, ...p }));
  const isNew = !initial.id;
  const save = async () => {
    const ok = await act.run(() => (isNew ? post('/settings/etc/rules', r) : patch(`/settings/etc/rules/${r.id}`, r)));
    if (ok) await onSaved();
  };
  const remove = async () => { if (confirm(`Remove “${r.name}”?`) && (await act.run(() => del(`/settings/etc/rules/${r.id}`)))) await onSaved(); };
  return (
    <Modal title={isNew ? 'New early termination rule' : `Edit: ${initial.name}`} onClose={onClose} wide>
      <div className="space-y-5">
        {act.error && <Alert>{act.error}</Alert>}
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-subhead font-semibold">When it applies</legend>
          <Field label="Name"><Input value={r.name} maxLength={80} onChange={(e) => upd({ name: e.target.value })} /></Field>
          <Field label="Priority" hint="Higher wins when several rules fit."><Input type="number" min={0} max={10000} value={r.priority} onChange={(e) => upd({ priority: Number(e.target.value) })} /></Field>
          <div className="sm:col-span-2"><Field label="Description"><Input value={r.description} maxLength={400} onChange={(e) => upd({ description: e.target.value })} /></Field></div>
          <div className="sm:col-span-2"><p className="mb-1 text-footnote font-medium text-label2">Situations (none ticked = any)</p>
            <div className="grid gap-1 sm:grid-cols-2">{v.scenarios.map((s) => <label key={s.id} className="flex items-center gap-2 text-subhead"><input type="checkbox" checked={r.scenarios.includes(s.id)} onChange={(e) => upd({ scenarios: e.target.checked ? [...r.scenarios, s.id] : r.scenarios.filter((x) => x !== s.id) })} /> {s.label}</label>)}</div></div>
          <Field label="Contract has"><Select value={r.device} onChange={(e) => upd({ device: e.target.value as Rule['device'] })}><option value="ANY">Either</option><option value="WITH_DEVICE">A device on instalments or a subsidy</option><option value="NO_DEVICE">Plan only</option></Select></Field>
          <Field label="VIP customer"><Select value={r.vip} onChange={(e) => upd({ vip: e.target.value as Rule['vip'] })}><option value="ANY">Either</option><option value="YES">VIP only</option><option value="NO">Not VIP</option></Select></Field>
          <Field label="Contract length (months), from"><Input type="number" min={0} value={r.minTerm ?? ''} onChange={(e) => upd({ minTerm: num(e.target.value) })} /></Field>
          <Field label="to"><Input type="number" min={0} value={r.maxTerm ?? ''} onChange={(e) => upd({ maxTerm: num(e.target.value) })} /></Field>
          <Field label="Months already served, from"><Input type="number" min={0} value={r.minElapsed ?? ''} onChange={(e) => upd({ minElapsed: num(e.target.value) })} /></Field>
          <Field label="to"><Input type="number" min={0} value={r.maxElapsed ?? ''} onChange={(e) => upd({ maxElapsed: num(e.target.value) })} /></Field>
          {segs.list.length > 0 && <div className="sm:col-span-2"><p className="mb-1 text-footnote font-medium text-label2">Customer segments (none ticked = all)</p>
            <div className="flex flex-wrap gap-3">{segs.list.map((s) => <label key={s.id} className="flex items-center gap-1.5 text-subhead"><input type="checkbox" checked={r.segments.includes(s.id)} onChange={(e) => upd({ segments: e.target.checked ? [...r.segments, s.id] : r.segments.filter((x) => x !== s.id) })} /> {s.name}</label>)}</div></div>}
        </fieldset>
        <FormulaBox value={r.formula} onChange={(formula) => upd({ formula })} v={v} />
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-subhead font-semibold">Limits</legend>
          <Field label="Least charge"><Input type="number" min={0} step={moneyStep()} defaultValue={toInput(r.minChargeMinor)} onBlur={(e) => upd({ minChargeMinor: toMinor(e.target.value || '0') })} /></Field>
          <Field label="Most charge" hint="Empty = no limit."><Input type="number" min={0} step={moneyStep()} defaultValue={r.maxChargeMinor === null ? '' : toInput(r.maxChargeMinor)} onBlur={(e) => upd({ maxChargeMinor: e.target.value === '' ? null : toMinor(e.target.value) })} /></Field>
          <Field label="No charge in the last (months)"><Input type="number" min={0} max={60} value={r.waiveLastMonths} onChange={(e) => upd({ waiveLastMonths: Number(e.target.value) })} /></Field>
          <Field label="Unpaid device instalments collected (%)"><Input type="number" min={0} max={100} value={r.deviceBalancePercent} onChange={(e) => upd({ deviceBalancePercent: Number(e.target.value) })} /></Field>
          <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={r.applyVipMultiplier} onChange={(e) => upd({ applyVipMultiplier: e.target.checked })} /> A VIP number’s multiplier applies to the charge</label>
          <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={r.enabled} onChange={(e) => upd({ enabled: e.target.checked })} /> Rule is on</label>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button disabled={act.busy || !r.name.trim() || !r.formula.trim()} onClick={() => void save()}>{isNew ? 'Create rule' : 'Save changes'}</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {!isNew && <Button variant="secondary" className="ml-auto text-danger" disabled={act.busy} onClick={() => void remove()}>Remove rule</Button>}
        </div>
      </div>
    </Modal>
  );
}

function TryIt({ v }: { v: View }) {
  const act = useAction();
  const [scenario, setScenario] = useState('CUSTOMER_REQUEST');
  const [f, setF] = useState({ term: '24', elapsed: '8', monthlyFee: '68', subsidy: '400', deviceBalance: '530', newMonthlyFee: '0', vipMultiplier: '1' });
  const [out, setOut] = useState<any>(null);
  const run = async () => {
    const figures = { term: Number(f.term), elapsed: Number(f.elapsed), monthlyFee: toMinor(f.monthlyFee), subsidy: toMinor(f.subsidy), deviceBalance: toMinor(f.deviceBalance), newMonthlyFee: toMinor(f.newMonthlyFee), vipMultiplier: Number(f.vipMultiplier) };
    const r = await act.run(() => post('/settings/etc/preview', { scenario, figures, hasDevice: figures.subsidy > 0 || figures.deviceBalance > 0 }));
    if (r) setOut(r);
  };
  const field = (k: keyof typeof f, l: string, hint?: string) => <Field label={l} hint={hint}><Input type="number" step="any" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <section aria-label="Try it">
      <SectionTitle>Try it</SectionTitle>
      <Card>
        <p className="mb-3 text-subhead text-label2">Enter a contract’s figures and see which rule applies and what it would charge. Nothing is saved.</p>
        {act.error && <Alert>{act.error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Situation"><Select value={scenario} onChange={(e) => setScenario(e.target.value)}>{v.scenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></Field>
          {field('term', 'Contract (months)')}{field('elapsed', 'Months served')}{field('monthlyFee', 'Monthly plan fee')}{field('subsidy', 'Device subsidy')}{field('deviceBalance', 'Unpaid device instalments')}{field('newMonthlyFee', 'New plan fee (plan change)')}{field('vipMultiplier', 'VIP multiplier')}
        </div>
        <div className="mt-3"><Button disabled={act.busy} onClick={() => void run()}>Work it out</Button></div>
        {out && (
          <div className="mt-4 rounded-card bg-surface2 p-4 text-subhead">
            {!out.matched && <p>No rule fits these figures: the offer’s own contract terms would decide.</p>}
            {out.error && <Alert>{out.error}</Alert>}
            {out.quote && <>
              <p><b>{out.quote.rule?.name}</b> · {out.quote.monthsRemaining} months left</p>
              <p className="mt-1 text-title3 font-semibold">{money(out.quote.chargeMinor)}{out.quote.waived ? ' (waived)' : ''}</p>
              {out.quote.deviceBalanceMinor > 0 && <p className="text-label2">plus unpaid device instalments {money(out.quote.deviceBalanceMinor)}</p>}
              <p className="mt-1 font-mono text-footnote text-label2">{out.quote.rule?.formula}</p></>}
          </div>)}
      </Card>
    </section>
  );
}
