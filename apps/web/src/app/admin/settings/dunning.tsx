'use client';
import { Alert, Badge, Button, Card, Field, Input, Modal, SectionTitle, Select, Spinner, Textarea } from '@meridian/ui';
import { useMemo, useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { getRegional, label, money, step as moneyStep, toInput, toMinor } from '@/lib/format';
import { useSegments } from '@/lib/segments';

type Action = 'NOTIFY' | 'LATE_FEE' | 'CASE_TASK' | 'SOFT_BAR' | 'HARD_BAR' | 'TERMINATE' | 'COLLECTIONS_TRANSFER';
type Trigger = { kind: 'DAYS_PAST_DUE'; days: number } | { kind: 'BALANCE'; balanceMinor: number; minDays: number };
interface Step { key: string; id?: string; name: string; enabled: boolean; trigger: Trigger; action: Action; params: Record<string, any>; exclusions: { dispute?: boolean; vip?: boolean; arrangement?: boolean } }
interface Partial_ { thresholdPercent: number; action: 'RESET_TO_SOFT_BAR' | 'PAUSE'; pauseDays: number }
interface Rule { id?: string; code?: string; name: string; description: string; active: boolean; priority: number; market: string | null; customerKind: 'ANY' | 'INDIVIDUAL' | 'BUSINESS'; segments: string[]; vip: 'ANY' | 'YES' | 'NO'; creditRisk: 'ANY' | 'HIGH' | 'NORMAL'; partial: Partial_ | null; version?: number; steps: any[] }
interface LateFee { id: string; code: string; name: string; mode: 'FLAT' | 'PERCENT'; flatMinor: number; percentBps: number; minMinor: number; maxMinor: number | null; taxable: boolean; active: boolean }
/** The limits of a rule, sent with the rules (core DUNNING_LIMITS plus the two the operator sets). Every input and hint on this page reads them; none is written here. */
interface Limits { priorityMin: number; maxPriority: number; maxSteps: number; nameMax: number; descriptionMax: number; stepNameMax: number; messageMax: number; teamMax: number; dayMax: number; dueHoursMax: number; waitDaysMax: number; partialThresholdMin: number; partialThresholdMax: number; pauseDaysMin: number; pauseDaysMax: number; bounds: { maxSteps: { min: number; max: number }; maxPriority: { min: number; max: number } }; defaults: { maxSteps: number; maxPriority: number } }
interface OverLimit { id: string; name: string; reasons: string[] }
interface View {
  limits: Limits; rulesOverLimit: OverLimit[]; qrTags: { min: number; max: number };
  rules: Rule[]; lateFees: LateFee[]; payments: { baseUrl: string; bureau: string; merchants: Record<string, any> };
  templates: Record<string, { label: string; text: string }>; channels: string[]; qrSchemes: Array<{ id: string; label: string }>; seaMarkets: string[];
}

const ACTIONS: Array<{ id: Action; label: string; hint: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = [
  { id: 'NOTIFY', label: 'Notify', hint: 'SMS, e-mail, WhatsApp or push, with a QR code', tone: 'neutral' },
  { id: 'LATE_FEE', label: 'Late fee', hint: 'Charge a late payment fee', tone: 'warning' },
  { id: 'CASE_TASK', label: 'Account manager task', hint: 'Ask a person to act, optionally holding the bars', tone: 'neutral' },
  { id: 'SOFT_BAR', label: 'Soft bar', hint: 'Block outgoing; incoming and self-service still work', tone: 'warning' },
  { id: 'HARD_BAR', label: 'Hard bar', hint: 'Full block; emergency calls exempt', tone: 'danger' },
  { id: 'COLLECTIONS_TRANSFER', label: 'Transfer to collections', hint: 'Place the debt with the collection agency', tone: 'danger' },
  { id: 'TERMINATE', label: 'Terminate', hint: 'End the services, charge the ETC, write off and/or place the debt', tone: 'danger' },
];
const actionInfo = (a: string) => ACTIONS.find((x) => x.id === a)!;
const KIND = { ANY: 'Any customer', INDIVIDUAL: 'Individuals', BUSINESS: 'Businesses' } as const;
let seq = 0;
const newKey = () => `s${Date.now().toString(36)}${seq++}`;

function defaults(action: Action, last: number): Step {
  const base = { key: newKey(), enabled: true, trigger: { kind: 'DAYS_PAST_DUE', days: last } as Trigger, action, exclusions: {} as Step['exclusions'] };
  switch (action) {
    case 'NOTIFY': return { ...base, name: 'Reminder', params: { channels: ['SMS'], template: 'FRIENDLY_REMINDER', includeQr: true } };
    case 'LATE_FEE': return { ...base, name: 'Late payment charge', params: {}, exclusions: { dispute: true, arrangement: true } };
    case 'CASE_TASK': return { ...base, name: 'Account manager follow-up', params: { team: 'Account management', dueHours: 72, holdsLaterBars: true, waitDays: 7 } };
    case 'SOFT_BAR': return { ...base, name: 'Soft bar', params: {}, exclusions: { dispute: true, arrangement: true } };
    case 'HARD_BAR': return { ...base, name: 'Hard bar', params: {}, exclusions: { dispute: true, arrangement: true } };
    case 'COLLECTIONS_TRANSFER': return { ...base, name: 'Place with the agency', params: {}, exclusions: { dispute: true, arrangement: true } };
    case 'TERMINATE': return { ...base, name: 'Terminate', params: { debt: 'BOTH' }, exclusions: { dispute: true, arrangement: true } };
  }
}
const toSteps = (r: Rule): Step[] => r.steps.map((s) => ({ ...s, key: s.id ?? newKey() }));
const blankRule = (): Rule => ({ name: '', description: '', active: true, priority: 100, market: null, customerKind: 'ANY', segments: [], vip: 'ANY', creditRisk: 'ANY', partial: null, steps: [] });
const dayOf = (s: Step) => (s.trigger.kind === 'DAYS_PAST_DUE' ? s.trigger.days : s.trigger.minDays);

function triggerText(s: Step, currency: string) {
  return s.trigger.kind === 'DAYS_PAST_DUE' ? `D+${s.trigger.days}` : `Balance ≥ ${money(s.trigger.balanceMinor, currency)}${s.trigger.minDays ? ` after D+${s.trigger.minDays}` : ''}`;
}
function conditionBadges(r: Rule, segName: (id: string) => string) {
  const b: string[] = [];
  b.push(r.market ? `Market ${r.market}` : 'Every market');
  if (r.customerKind !== 'ANY') b.push(KIND[r.customerKind]);
  if (r.segments.length) b.push(r.segments.map(segName).join(', '));
  if (r.vip !== 'ANY') b.push(r.vip === 'YES' ? 'VIP' : 'Not VIP');
  if (r.creditRisk !== 'ANY') b.push(r.creditRisk === 'HIGH' ? 'High credit risk' : 'Normal credit risk');
  return b;
}

/** Settings → Dunning rules: who is chased, in what order, with what. Rules are tried by priority; a ladder is built by dragging steps into order. */
export function DunningSettings() {
  const view = useApi<View>('/settings/dunning-rules');
  const act = useAction(async () => { await view.reload(); });
  const segs = useSegments();
  const [editing, setEditing] = useState<Rule | null>(null);
  const [market, setMarket] = useState('');
  if (view.error) return <Alert>{view.error}</Alert>;
  if (!view.data) return <Spinner />;
  const v = view.data;
  const currency = getRegional().currency;
  const rules = [...v.rules].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  return (
    <div className="space-y-6">
      <Card>
        <p className="text-subhead text-label2">A <strong className="text-label">rule</strong> says who it applies to (market, customer type, segment, VIP, credit risk) and holds a <strong className="text-label">ladder</strong> of steps: on day D+X past due, or when the overdue balance reaches an amount, send a reminder, charge a late fee, bar the service, terminate. For each customer the matching rule with the <strong className="text-label">highest priority</strong> is used. Customers no active rule fits follow the older single ladder set in the lifecycle settings (there is no screen for it yet). A ladder already under way is not changed by editing a rule; the next one uses the new version.</p>
      </Card>
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}

      <section aria-label="Rules">
        <SectionTitle action={<Button onClick={() => setEditing(blankRule())}>＋ New rule</Button>}>Rules</SectionTitle>
        {rules.length === 0 && (
          <Card>
            <p className="mb-3 text-subhead text-label2">There are no rules yet. Start from the Southeast Asia set for a market (a late fee and four rules: consumer standard, VIP, enterprise and high risk, with that market’s QR payment scheme), then adjust it.</p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Market"><Select value={market} onChange={(e) => setMarket(e.target.value)}><option value="">The regional market</option>{v.seaMarkets.map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
              <Button disabled={act.busy} onClick={() => void act.run(() => post('/settings/dunning-rules/seed', market ? { market } : {}), 'Loaded the starter rules')}>Load Southeast Asia defaults</Button>
            </div>
          </Card>
        )}
        <ul className="space-y-3">
          {rules.map((r) => (
            <li key={r.id}>
              <Card className={r.active ? '' : 'opacity-70'}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{r.name}</h3><Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'On' : 'Off'}</Badge><span className="text-footnote text-label2">Priority {r.priority} · v{r.version}</span>{(r.priority > v.limits.maxPriority || r.steps.length > v.limits.maxSteps) && <Badge tone="warning">Over the limits: fix before saving</Badge>}</div>
                    {r.description && <p className="mt-1 text-subhead text-label2">{r.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5">{conditionBadges(r, segs.name).map((c) => <Badge key={c}>{c}</Badge>)}</div>
                    <ol className="mt-3 flex flex-wrap items-center gap-1.5 text-footnote">
                      {r.steps.map((s: any) => <li key={s.id}><span className={`inline-flex items-center gap-1 rounded-control bg-surface2 px-2 py-1 ${s.enabled ? '' : 'line-through opacity-60'}`}><b>{triggerText({ ...s, key: '' }, currency)}</b> {actionInfo(s.action)?.label ?? s.action}</span></li>)}
                    </ol>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => setEditing({ ...r })}>Edit</Button>
                    <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post(`/settings/dunning-rules/${r.id}/active`, { active: !r.active }))}>{r.active ? 'Switch off' : 'Switch on'}</Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
        {rules.length > 0 && <p className="mt-2 text-footnote text-label2">Add any missing starter rules for the regional market: <button type="button" className="text-accent" onClick={() => void act.run(() => post('/settings/dunning-rules/seed', {}), 'Loaded the starter rules for the regional market')}>load them</button>. Rules you have already loaded or changed are kept.</p>}
      </section>

      <LimitsSettings limits={v.limits} over={v.rulesOverLimit} reload={view.reload} />
      <LateFees fees={v.lateFees} reload={view.reload} currency={currency} />
      <PaymentSettings payments={v.payments} schemes={v.qrSchemes} tags={v.qrTags} reload={view.reload} />
      <Preview />
      {editing && <RuleEditor key={editing.id ?? 'new'} initial={editing} view={v} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await view.reload(); }} />}
    </div>
  );
}

// ───────────────────────── the ladder builder ─────────────────────────
function RuleEditor({ initial, view, onClose, onSaved }: { initial: Rule; view: View; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const segs = useSegments();
  const act = useAction();
  const [r, setR] = useState<Rule>(initial);
  const [steps, setSteps] = useState<Step[]>(() => toSteps(initial));
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number } | { palette: Action } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const isNew = !initial.id;
  const lim = view.limits;
  const full = steps.length >= lim.maxSteps;
  const upd = (patch_: Partial<Rule>) => setR((x) => ({ ...x, ...patch_ }));
  const move = (from: number, to: number) => setSteps((s) => { if (from === to || to < 0 || to >= s.length) return s; const n = [...s]; n.splice(to, 0, n.splice(from, 1)[0]!); return n; });
  const insert = (action: Action, at: number) => {
    if (steps.length >= lim.maxSteps) return;
    const last = steps.length ? Math.max(0, ...steps.map(dayOf)) : 1;
    const s = defaults(action, last);
    setSteps((x) => { const n = [...x]; n.splice(Math.min(at, n.length), 0, s); return n; });
    setOpen(s.key);
  };
  const drop = (at: number) => {
    if (drag && 'from' in drag) move(drag.from, drag.from < at ? at - 1 : at);
    else if (drag) insert(drag.palette, at);
    setDrag(null); setOver(null);
  };
  const setStep = (key: string, p: Partial<Step>) => setSteps((x) => x.map((s) => (s.key === key ? { ...s, ...p } : s)));
  const sorted = steps.every((s, i) => i === 0 || s.trigger.kind === 'BALANCE' || steps[i - 1]!.trigger.kind === 'BALANCE' || dayOf(steps[i - 1]!) <= dayOf(s));
  const sortByDay = () => setSteps((x) => [...x].sort((a, b) => dayOf(a) - dayOf(b)));

  const save = async () => {
    const body = { ...r, code: r.code, market: r.market || null, partial: r.partial,
      steps: steps.map((s, i) => ({ id: s.id, position: i, name: s.name, enabled: s.enabled, trigger: s.trigger, action: s.action, params: s.params, exclusions: s.exclusions })) };
    const ok = await act.run(() => (isNew ? post('/settings/dunning-rules', body) : patch(`/settings/dunning-rules/${r.id}`, body)));
    if (ok) await onSaved();
  };
  const remove = async () => { if (confirm(`Remove “${r.name}” for good? Removal is refused only while accounts are still being chased under it (a ladder they have started and not finished); then switch the rule off instead and they finish that ladder. Accounts that have finished keep their history.`) && (await act.run(() => del(`/settings/dunning-rules/${r.id}`)))) await onSaved(); };

  return (
    <Modal title={isNew ? 'New dunning rule' : `Edit: ${initial.name}`} onClose={onClose} wide>
      <div className="space-y-5">
        {act.error && <Alert>{act.error}</Alert>}
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-subhead font-semibold">Who it applies to</legend>
          <Field label="Name"><Input value={r.name} maxLength={lim.nameMax} onChange={(e) => upd({ name: e.target.value })} /></Field>
          <Field label="Priority" hint={`Higher wins when several rules fit. ${lim.priorityMin} to ${lim.maxPriority.toLocaleString('en-US')}.`} error={r.priority > lim.maxPriority ? `The highest priority allowed is now ${lim.maxPriority.toLocaleString('en-US')}. Lower this rule's priority to save it.` : undefined}><Input type="number" min={lim.priorityMin} max={lim.maxPriority} value={r.priority} onChange={(e) => upd({ priority: Number(e.target.value) })} /></Field>
          <Field label="Description"><Input value={r.description} maxLength={lim.descriptionMax} onChange={(e) => upd({ description: e.target.value })} /></Field>
          <Field label="Market"><Select value={r.market ?? ''} onChange={(e) => upd({ market: e.target.value || null })}><option value="">Every market</option>{view.seaMarkets.map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
          <Field label="Customer type"><Select value={r.customerKind} onChange={(e) => upd({ customerKind: e.target.value as Rule['customerKind'] })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="VIP"><Select value={r.vip} onChange={(e) => upd({ vip: e.target.value as Rule['vip'] })}><option value="ANY">Either</option><option value="YES">VIP only</option><option value="NO">Not VIP</option></Select></Field>
          <Field label="Credit risk" hint="Set on the customer by an administrator."><Select value={r.creditRisk} onChange={(e) => upd({ creditRisk: e.target.value as Rule['creditRisk'] })}><option value="ANY">Either</option><option value="HIGH">High risk only</option><option value="NORMAL">Normal</option></Select></Field>
          <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={r.active} onChange={(e) => upd({ active: e.target.checked })} /> Rule is on</label>
          {segs.list.length > 0 && (
            <div className="sm:col-span-2"><p className="mb-1 text-footnote font-medium text-label2">Segments (none ticked = every segment)</p>
              <div className="flex flex-wrap gap-3">{segs.list.map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 text-subhead"><input type="checkbox" checked={r.segments.includes(s.id)} onChange={(e) => upd({ segments: e.target.checked ? [...r.segments, s.id] : r.segments.filter((x) => x !== s.id) })} /> {s.name}</label>))}</div></div>)}
        </fieldset>

        <section aria-label="Ladder">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-subhead font-semibold">The ladder <span className={`font-normal ${steps.length > lim.maxSteps ? 'text-danger' : 'text-label2'}`}>· {steps.length} of {lim.maxSteps} steps{steps.length > lim.maxSteps ? `: remove ${steps.length - lim.maxSteps} to save` : full ? ': full' : ''}</span></h3>
            {!sorted && <button type="button" className="text-footnote text-accent" onClick={sortByDay}>Steps are out of day order: sort by day</button>}
          </div>
          <div className="grid gap-4 md:grid-cols-[200px_minmax(0,1fr)]">
            <div>
              <p className="mb-1 text-footnote text-label2">{full ? `The ladder is full (at most ${lim.maxSteps} steps). Remove a step to add another.` : 'Drag a step into the ladder, or tap to add at the end.'}</p>
              <ul className="grid grid-cols-2 gap-1.5 md:grid-cols-1">
                {ACTIONS.map((a) => (
                  <li key={a.id}>
                    <button type="button" draggable={!full} disabled={full} title={a.hint}
                      onDragStart={(e) => { e.dataTransfer.setData('text/plain', a.id); e.dataTransfer.effectAllowed = 'copy'; setDrag({ palette: a.id }); }}
                      onDragEnd={() => { setDrag(null); setOver(null); }}
                      onClick={() => insert(a.id, steps.length)}
                      className="flex min-h-tap w-full cursor-grab items-center gap-2 rounded-control border border-separator bg-surface px-3 py-2 text-left text-subhead active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                      <span aria-hidden className="text-label2">⠿</span>{a.label}
                    </button>
                  </li>))}
              </ul>
            </div>
            <ol className="min-w-0 space-y-1.5" onDragOver={(e) => e.preventDefault()}>
              {steps.length === 0 && <li onDragOver={(e) => { e.preventDefault(); setOver(0); }} onDrop={(e) => { e.preventDefault(); drop(0); }} className="rounded-card border-2 border-dashed border-separator px-4 py-8 text-center text-subhead text-label2">Drop the first step here.</li>}
              {steps.map((s, i) => {
                const info = actionInfo(s.action);
                const shown = open === s.key;
                return (
                  <li key={s.key}>
                    {over === i && drag && <div className="mb-1 h-1 rounded bg-accent" aria-hidden />}
                    <div draggable={!shown}
                      onDragStart={(e) => { e.dataTransfer.setData('text/plain', s.key); e.dataTransfer.effectAllowed = 'move'; setDrag({ from: i }); }}
                      onDragEnd={() => { setDrag(null); setOver(null); }}
                      onDragOver={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); setOver(e.clientY > rect.top + rect.height / 2 ? i + 1 : i); }}
                      onDrop={(e) => { e.preventDefault(); drop(over ?? i); }}
                      className={`rounded-card border bg-surface ${shown ? 'border-accent' : 'border-separator'} ${drag && 'from' in drag && drag.from === i ? 'opacity-40' : ''}`}>
                      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <span aria-hidden className={`cursor-grab select-none text-label2 ${shown ? 'invisible' : ''}`} title="Drag to reorder">⠿</span>
                        <Badge tone={s.enabled ? info.tone : 'neutral'}>{triggerText(s, getRegional().currency)}</Badge>
                        <button type="button" onClick={() => setOpen(shown ? null : s.key)} aria-expanded={shown} className={`min-w-0 flex-1 truncate text-left font-medium ${s.enabled ? '' : 'line-through opacity-60'}`}>{s.name} <span className="font-normal text-label2">· {info.label}</span></button>
                        {s.exclusions.dispute && <Badge>Skips disputes</Badge>}{s.exclusions.vip && <Badge>Skips VIP</Badge>}{s.exclusions.arrangement && <Badge>Skips arrangements</Badge>}
                        <span className="flex gap-1">
                          <button type="button" aria-label="Move up" disabled={i === 0} className="min-h-[32px] px-2 text-label2 disabled:opacity-30" onClick={() => move(i, i - 1)}>↑</button>
                          <button type="button" aria-label="Move down" disabled={i === steps.length - 1} className="min-h-[32px] px-2 text-label2 disabled:opacity-30" onClick={() => move(i, i + 1)}>↓</button>
                          <button type="button" aria-label="Remove step" className="min-h-[32px] px-2 text-danger" onClick={() => setSteps((x) => x.filter((y) => y.key !== s.key))}>✕</button>
                        </span>
                      </div>
                      {shown && <StepEditor s={s} set={(p) => setStep(s.key, p)} view={view} />}
                    </div>
                  </li>);
              })}
              {steps.length > 0 && <li onDragOver={(e) => { e.preventDefault(); setOver(steps.length); }} onDrop={(e) => { e.preventDefault(); drop(steps.length); }} className={`h-6 rounded ${over === steps.length && drag ? 'border-t-4 border-accent' : ''}`} aria-hidden />}
            </ol>
          </div>
        </section>

        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-2 text-subhead font-semibold">Partial payments</legend>
          <label className="flex min-h-tap items-center gap-2 text-subhead sm:col-span-3"><input type="checkbox" checked={!!r.partial} onChange={(e) => upd({ partial: e.target.checked ? { thresholdPercent: 80, action: 'RESET_TO_SOFT_BAR', pauseDays: 7 } : null })} /> React to a payment that leaves something overdue</label>
          {r.partial && <>
            <Field label="When it covers at least (%)"><Input type="number" min={lim.partialThresholdMin} max={lim.partialThresholdMax} value={r.partial.thresholdPercent} onChange={(e) => upd({ partial: { ...r.partial!, thresholdPercent: Number(e.target.value) } })} /></Field>
            <Field label="Then"><Select value={r.partial.action} onChange={(e) => upd({ partial: { ...r.partial!, action: e.target.value as Partial_['action'] } })}><option value="RESET_TO_SOFT_BAR">Lift a hard bar to a soft bar and pause</option><option value="PAUSE">Pause the ladder</option></Select></Field>
            <Field label="Pause for (days)"><Input type="number" min={lim.pauseDaysMin} max={lim.pauseDaysMax} value={r.partial.pauseDays} onChange={(e) => upd({ partial: { ...r.partial!, pauseDays: Number(e.target.value) } })} /></Field></>}
        </fieldset>

        <div className="flex flex-wrap gap-2">
          <Button disabled={act.busy || !r.name.trim()} onClick={() => void save()}>{isNew ? 'Create rule' : 'Save changes'}</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {!isNew && <Button variant="secondary" className="ml-auto text-danger" disabled={act.busy} onClick={() => void remove()}>Remove rule</Button>}
        </div>
      </div>
    </Modal>
  );
}

function StepEditor({ s, set, view }: { s: Step; set: (p: Partial<Step>) => void; view: View }) {
  const p = s.params;
  const setP = (x: Record<string, any>) => set({ params: { ...p, ...x } });
  const t = s.trigger;
  const lim = view.limits;
  const text = p.template ? view.templates[p.template]?.text : undefined;
  return (
    <div className="grid gap-3 border-t border-separator px-3 py-3 sm:grid-cols-2">
      <Field label="Name"><Input value={s.name} maxLength={lim.stepNameMax} onChange={(e) => set({ name: e.target.value })} /></Field>
      <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Step is on</label>
      <Field label="Triggered by"><Select value={t.kind} onChange={(e) => set({ trigger: e.target.value === 'BALANCE' ? { kind: 'BALANCE', balanceMinor: 10000, minDays: 1 } : { kind: 'DAYS_PAST_DUE', days: t.kind === 'BALANCE' ? t.minDays : 1 } })}><option value="DAYS_PAST_DUE">Days past due (D+X)</option><option value="BALANCE">Overdue balance reaches an amount</option></Select></Field>
      {t.kind === 'DAYS_PAST_DUE'
        ? <Field label="Day past due"><Input type="number" min={0} max={lim.dayMax} value={t.days} onChange={(e) => set({ trigger: { kind: 'DAYS_PAST_DUE', days: Number(e.target.value) } })} /></Field>
        : <div className="grid grid-cols-2 gap-3">
            <Field label="Overdue balance of at least"><Input type="number" min={0} step={moneyStep()} defaultValue={toInput(t.balanceMinor)} onBlur={(e) => set({ trigger: { ...t, balanceMinor: toMinor(e.target.value) } })} /></Field>
            <Field label="And at least (days past due)"><Input type="number" min={0} max={lim.dayMax} value={t.minDays} onChange={(e) => set({ trigger: { ...t, minDays: Number(e.target.value) } })} /></Field></div>}

      {s.action === 'NOTIFY' && <>
        <div className="sm:col-span-2"><p className="mb-1 text-footnote font-medium text-label2">Channels</p>
          <div className="flex flex-wrap gap-4">{view.channels.map((c) => <label key={c} className="flex items-center gap-1.5 text-subhead"><input type="checkbox" checked={(p.channels ?? []).includes(c)} onChange={(e) => setP({ channels: e.target.checked ? [...(p.channels ?? []), c] : (p.channels ?? []).filter((x: string) => x !== c) })} /> {label(c)}</label>)}</div></div>
        <Field label="Message"><Select value={p.template ?? ''} onChange={(e) => setP({ template: e.target.value || undefined })}>{Object.entries(view.templates).map(([k, tpl]) => <option key={k} value={k}>{tpl.label}</option>)}<option value="">My own text</option></Select></Field>
        <div className="space-y-2">
          <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={!!p.includeQr} onChange={(e) => setP({ includeQr: e.target.checked })} /> Include a QR payment code</label>
          {p.includeQr && <Select aria-label="QR scheme" value={p.qrScheme ?? ''} onChange={(e) => setP({ qrScheme: e.target.value || undefined })}><option value="">No scheme chosen (no QR code is sent)</option>{view.qrSchemes.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</Select>}
          <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={!!p.final} onChange={(e) => setP({ final: e.target.checked })} /> Final demand (states the early-termination charge and date)</label></div>
        <div className="sm:col-span-2">
          {p.template ? <p className="rounded-control bg-surface2 px-3 py-2 text-footnote text-label2">{text}</p>
            : <Field label="Your message" hint={`Use {{name}}, {{balance}}, {{dueDate}}, {{daysPastDue}}, {{qr}}, {{payUrl}}. Up to ${lim.messageMax.toLocaleString('en-US')} characters.`}><Textarea rows={3} maxLength={lim.messageMax} value={p.message ?? ''} onChange={(e) => setP({ message: e.target.value })} /></Field>}</div></>}

      {s.action === 'LATE_FEE' && (
        <Field label="Late fee"><Select value={p.lateFeeId ?? ''} onChange={(e) => setP({ lateFeeId: e.target.value })}><option value="">Choose…</option>{view.lateFees.filter((f) => f.active).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></Field>)}

      {s.action === 'CASE_TASK' && <>
        <Field label="Team"><Input value={p.team ?? ''} maxLength={lim.teamMax} onChange={(e) => setP({ team: e.target.value })} /></Field>
        <Field label="Task is due in (hours)"><Input type="number" min={1} max={lim.dueHoursMax} value={p.dueHours ?? 72} onChange={(e) => setP({ dueHours: Number(e.target.value) })} /></Field>
        <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={!!p.holdsLaterBars} onChange={(e) => setP({ holdsLaterBars: e.target.checked })} /> Hold later bars, termination and the transfer to debt collection while the task is open</label>
        {p.holdsLaterBars && <Field label="Wait for the task (days)"><Input type="number" min={1} max={lim.waitDaysMax} value={p.waitDays ?? 7} onChange={(e) => setP({ waitDays: Number(e.target.value) })} /></Field>}</>}

      {s.action === 'TERMINATE' && (
        <Field label="The debt is"><Select value={p.debt ?? 'BOTH'} onChange={(e) => setP({ debt: e.target.value })}><option value="WRITE_OFF">Written off</option><option value="COLLECTIONS">Placed with the collection agency</option><option value="BOTH">Written off and placed with the agency</option></Select></Field>)}

      <div className="sm:col-span-2"><p className="mb-1 text-footnote font-medium text-label2">Skip this step while…</p>
        <div className="flex flex-wrap gap-4">
          {([['dispute', 'a billing dispute is open'], ['vip', 'the customer is a VIP'], ['arrangement', 'a payment arrangement is kept']] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-1.5 text-subhead"><input type="checkbox" checked={!!s.exclusions[k]} onChange={(e) => set({ exclusions: { ...s.exclusions, [k]: e.target.checked || undefined } })} /> {l}</label>))}</div></div>
    </div>
  );
}

// ───────────────────────── late fees ─────────────────────────
function LateFees({ fees, reload, currency }: { fees: LateFee[]; reload: () => void | Promise<void>; currency: string }) {
  const act = useAction(reload);
  const [f, setF] = useState<(Partial<LateFee> & { name: string; mode: 'FLAT' | 'PERCENT' }) | null>(null);
  const describe = (x: LateFee) => (x.mode === 'FLAT' ? money(x.flatMinor, currency) : `${x.percentBps / 100}% of the overdue balance${x.minMinor ? `, at least ${money(x.minMinor, currency)}` : ''}${x.maxMinor ? `, at most ${money(x.maxMinor, currency)}` : ''}`);
  const save = async () => {
    const body = { name: f!.name, mode: f!.mode, flatMinor: f!.flatMinor ?? 0, percentBps: f!.percentBps ?? 0, minMinor: f!.minMinor ?? 0, maxMinor: f!.maxMinor ?? null, taxable: !!f!.taxable, active: f!.active ?? true };
    if (await act.run(() => (f!.id ? patch(`/settings/dunning-rules/late-fees/${f!.id}`, body) : post('/settings/dunning-rules/late-fees', body)), 'Saved')) setF(null);
  };
  return (
    <section aria-label="Late fees">
      <SectionTitle action={<Button variant="secondary" onClick={() => setF({ name: '', mode: 'FLAT' })}>＋ New late fee</Button>}>Late fees</SectionTitle>
      <Card>
        {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        {fees.length === 0 ? <p className="text-subhead text-label2">None yet. A late fee is a flat amount or a percentage of the overdue balance, billed as its own invoice.</p> : (
          <ul className="divide-y divide-separator">{fees.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1"><span className="font-medium">{x.name}</span> {!x.active && <Badge>Off</Badge>}<p className="text-footnote text-label2">{describe(x)}{x.taxable ? ' · taxable' : ''}</p></div>
              <Button variant="secondary" onClick={() => setF({ ...x })}>Edit</Button>
              <button type="button" className="text-footnote text-danger" onClick={() => void act.run(() => del(`/settings/dunning-rules/late-fees/${x.id}`), 'Removed')}>Remove</button>
            </li>))}</ul>)}
      </Card>
      {f && (
        <Modal title={f.id ? 'Edit late fee' : 'New late fee'} onClose={() => setF(null)}>
          <div className="grid gap-3">
            {act.error && <Alert>{act.error}</Alert>}
            <Field label="Name"><Input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Charged as"><Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as 'FLAT' | 'PERCENT' })}><option value="FLAT">A flat amount</option><option value="PERCENT">A percentage of the overdue balance</option></Select></Field>
            {f.mode === 'FLAT'
              ? <Field label={`Amount (${currency})`}><Input type="number" min={0} step={moneyStep()} defaultValue={toInput(f.flatMinor)} onBlur={(e) => setF({ ...f, flatMinor: toMinor(e.target.value) })} /></Field>
              : <>
                <Field label="Percentage" hint="For example 1.5 for 1.5%."><Input type="number" min={0} max={100} step="0.01" defaultValue={(f.percentBps ?? 0) / 100} onBlur={(e) => setF({ ...f, percentBps: Math.round(Number(e.target.value) * 100) })} /></Field>
                <Field label="At least"><Input type="number" min={0} step={moneyStep()} defaultValue={toInput(f.minMinor)} onBlur={(e) => setF({ ...f, minMinor: toMinor(e.target.value) })} /></Field>
                <Field label="At most" hint="Leave empty for no limit."><Input type="number" min={0} step={moneyStep()} defaultValue={f.maxMinor ? toInput(f.maxMinor) : ''} onBlur={(e) => setF({ ...f, maxMinor: e.target.value ? toMinor(e.target.value) : null })} /></Field></>}
            <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={!!f.taxable} onChange={(e) => setF({ ...f, taxable: e.target.checked })} /> Tax is charged on the fee</label>
            <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={f.active ?? true} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Fee is on</label>
            <div className="flex gap-2"><Button disabled={act.busy || !f.name.trim()} onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button></div>
          </div>
        </Modal>)}
    </section>
  );
}

// ───────────────────────── limits ─────────────────────────
/** The two limits the operator sets. Lowering one never touches existing rules: the ones now over it are listed, still load and can be viewed, and ask for a fix when saved. */
function LimitsSettings({ limits, over, reload }: { limits: Limits; over: OverLimit[]; reload: () => void | Promise<void> }) {
  const act = useAction(reload);
  const [steps, setSteps] = useState(String(limits.maxSteps));
  const [prio, setPrio] = useState(String(limits.maxPriority));
  const b = limits.bounds;
  const stepsN = Number(steps), prioN = Number(prio);
  const okSteps = Number.isInteger(stepsN) && stepsN >= b.maxSteps.min && stepsN <= b.maxSteps.max;
  const okPrio = Number.isInteger(prioN) && prioN >= b.maxPriority.min && prioN <= b.maxPriority.max;
  const changed = stepsN !== limits.maxSteps || prioN !== limits.maxPriority;
  return (
    <section aria-label="Limits">
      <SectionTitle>Limits</SectionTitle>
      <Card>
        <p className="mb-3 text-subhead text-label2">How big a rule may be. Lowering a limit never changes the rules you already have: any that are over it keep working and can be viewed, and you are asked to fix them the next time you save them (switching them on or off is always possible).</p>
        {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        {over.length > 0 && <Alert>Over the limits now: {over.map((o) => `${o.name} (${o.reasons.join(', ')})`).join('; ')}.</Alert>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Most steps in a ladder" hint={`${b.maxSteps.min} to ${b.maxSteps.max}. Standard: ${limits.defaults.maxSteps}.`} error={steps !== '' && !okSteps ? `Enter a whole number from ${b.maxSteps.min} to ${b.maxSteps.max}.` : undefined}><Input type="number" min={b.maxSteps.min} max={b.maxSteps.max} step={1} value={steps} onChange={(e) => setSteps(e.target.value)} /></Field>
          <Field label="Highest priority a rule may have" hint={`${b.maxPriority.min} to ${b.maxPriority.max.toLocaleString('en-US')}. Standard: ${limits.defaults.maxPriority.toLocaleString('en-US')}. Rules start at 0.`} error={prio !== '' && !okPrio ? `Enter a whole number from ${b.maxPriority.min} to ${b.maxPriority.max.toLocaleString('en-US')}.` : undefined}><Input type="number" min={b.maxPriority.min} max={b.maxPriority.max} step={1} value={prio} onChange={(e) => setPrio(e.target.value)} /></Field>
        </div>
        <div className="mt-3"><Button disabled={act.busy || !okSteps || !okPrio || !changed} onClick={() => void act.run(() => post('/settings/dunning-rules/limits', { maxSteps: stepsN, maxPriority: prioN }), 'Saved')}>Save limits</Button></div>
      </Card>
    </section>
  );
}

// ───────────────────────── pay page and QR merchants ─────────────────────────
const SCHEME_FIELDS: Record<string, { proxy?: string; uen?: string; tag?: string }> = {
  PROMPTPAY: { proxy: 'Biller phone number or tax ID' }, PAYNOW: { uen: 'Company UEN' },
  DUITNOW: { tag: 'Merchant account tag' }, QRIS: { tag: 'Merchant account tag' }, QRPH: { tag: 'Merchant account tag' },
};
function PaymentSettings({ payments, schemes, tags, reload }: { payments: View['payments']; schemes: View['qrSchemes']; tags: View['qrTags']; reload: () => void | Promise<void> }) {
  const act = useAction(reload);
  const [base, setBase] = useState(payments.baseUrl);
  const [bureau, setBureau] = useState(payments.bureau);
  const [scheme, setScheme] = useState(schemes[0]?.id ?? 'PROMPTPAY');
  const cur = payments.merchants[scheme] ?? {};
  const first = Object.entries(cur.accounts ?? {})[0] as [string, string] | undefined;
  const [m, setM] = useState({ name: cur.name ?? '', city: cur.city ?? '', proxy: cur.proxy ?? '', uen: cur.uen ?? '', tag: first?.[0] ?? '51', value: first?.[1] ?? '' });
  const pick = (id: string) => {
    setScheme(id);
    const c = payments.merchants[id] ?? {}; const a = Object.entries(c.accounts ?? {})[0] as [string, string] | undefined;
    setM({ name: c.name ?? '', city: c.city ?? '', proxy: c.proxy ?? '', uen: c.uen ?? '', tag: a?.[0] ?? '51', value: a?.[1] ?? '' });
  };
  const fields = SCHEME_FIELDS[scheme] ?? {};
  const saveAll = () => {
    const merchant: any = { name: m.name, city: m.city };
    if (fields.proxy) merchant.proxy = m.proxy;
    if (fields.uen) merchant.uen = m.uen;
    if (fields.tag) merchant.accounts = m.value ? { [m.tag]: m.value } : {};
    return act.run(() => post('/settings/dunning-rules/payments', { baseUrl: base, bureau, merchants: m.name ? { [scheme]: merchant } : {} }), 'Saved');
  };
  return (
    <section aria-label="Payment links and QR codes">
      <SectionTitle>Payment links and QR codes</SectionTitle>
      <Card>
        <p className="mb-3 text-subhead text-label2">What reminders carry so the customer can pay at once: a link to your pay page and a QR code for the local scheme. The code is built to the EMVCo standard with the amount and invoice reference. Test a new setup with your bank’s QR checker before relying on it.</p>
        {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Pay page address" hint="Must start with https://"><Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://pay.example.com" /></Field>
          <Field label="Credit bureau named in final demands"><Input value={bureau} maxLength={80} onChange={(e) => setBureau(e.target.value)} /></Field>
          <Field label="QR scheme"><Select value={scheme} onChange={(e) => pick(e.target.value)}>{schemes.map((s) => <option key={s.id} value={s.id}>{s.label}{payments.merchants[s.id] ? ' ✓' : ''}</option>)}</Select></Field>
          <span />
          <Field label="Merchant name" hint="Up to 25 characters"><Input value={m.name} maxLength={25} onChange={(e) => setM({ ...m, name: e.target.value })} /></Field>
          <Field label="City" hint="Up to 15 characters"><Input value={m.city} maxLength={15} onChange={(e) => setM({ ...m, city: e.target.value })} /></Field>
          {fields.proxy && <Field label={fields.proxy}><Input value={m.proxy} onChange={(e) => setM({ ...m, proxy: e.target.value })} /></Field>}
          {fields.uen && <Field label={fields.uen}><Input value={m.uen} onChange={(e) => setM({ ...m, uen: e.target.value })} /></Field>}
          {fields.tag && <><Field label={`${fields.tag} (${tags.min}–${tags.max})`} hint={`The EMV QR field number your acquirer gave you for the merchant account: ${tags.min} to ${tags.max}.`}><Input value={m.tag} maxLength={2} inputMode="numeric" onChange={(e) => setM({ ...m, tag: e.target.value })} className="font-mono" /></Field>
            <Field label="Merchant account value" hint="As supplied by your acquirer."><Input value={m.value} onChange={(e) => setM({ ...m, value: e.target.value })} className="font-mono" /></Field></>}
        </div>
        <div className="mt-3"><Button disabled={act.busy} onClick={() => void saveAll()}>Save</Button></div>
      </Card>
    </section>
  );
}

// ───────────────────────── where would an account be today ─────────────────────────
function Preview() {
  const [accountId, setAccountId] = useState('');
  const [result, setResult] = useState<any>(null);
  const act = useAction();
  const valid = /^[0-9a-f-]{36}$/i.test(accountId.trim());
  const run = async () => { const r = await act.run(() => post('/settings/dunning-rules/preview', { accountId: accountId.trim() })); if (r) setResult(r); };
  const states = useMemo(() => ({ DONE: ['success', 'Done'], SUPERSEDED: ['neutral', 'Skipped'], DUE: ['warning', 'Due now'], HELD: ['warning', 'Held'], LATER: ['neutral', 'Later'] } as const), []);
  return (
    <section aria-label="Where an account stands">
      <SectionTitle>Where an account stands</SectionTitle>
      <Card>
        <p className="mb-3 text-subhead text-label2">Paste an account’s ID to see which rule fits it and what happens next. Nothing is changed.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Account ID"><Input value={accountId} onChange={(e) => setAccountId(e.target.value)} className="font-mono" /></Field>
          <Button disabled={!valid || act.busy} onClick={() => void run()}>Show ladder</Button>
        </div>
        {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
        {result && (
          <div className="mt-4">
            <p className="text-subhead">{result.rule ? <>Rule <b>{result.rule.name}</b> (v{result.rule.version})</> : 'No rule fits: the lifecycle ladder applies.'} · {result.daysPastDue} days past due · overdue {money(result.balanceMinor)}{result.pausedUntil ? ` · paused until ${result.pausedUntil}` : ''}</p>
            <ol className="mt-2 space-y-1">{result.steps.map((s: any) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 text-subhead"><Badge tone={states[s.state as keyof typeof states][0]}>{states[s.state as keyof typeof states][1]}</Badge><span>{s.name}</span><span className="text-footnote text-label2">{s.dueOn ? `on ${s.dueOn}` : ''}{s.reason ? ` · ${s.reason}` : ''}</span></li>))}</ol>
          </div>)}
      </Card>
    </section>
  );
}
