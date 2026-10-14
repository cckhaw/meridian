'use client';
import { Alert, Badge, Button, Card, Field, Input, Modal, Segmented, Select, Spinner } from '@meridian/ui';
import { useEffect, useState } from 'react';
import { api, del, patch, post, useAction, useApi, useDebounced } from '@/lib/api';
import { label, step, toInput, toMinor } from '@/lib/format';

type Cond = { fact: string; op: string; value: any };
interface Rule { id: string; name: string; action: string; group: string; priority: number; enabled: boolean; when: Cond[]; outcome: any; message?: string; showInTerms: boolean }
interface FactMeta { id: string; label: string; type: 'number' | 'enum' | 'bool' | 'text' | 'list'; unit?: string; values?: Array<[string, string]>; help: string; groups?: string[] }
interface View { rules: Rule[]; settings: { defaultAllow: boolean }; facts: FactMeta[]; ops: Array<{ id: string; label: string; types: string[] }>; currency: string; descriptions: Record<string, string> }

const ACTIONS = [
  { value: 'CANCEL', label: 'Cancelling', help: 'May a part of an order be cancelled, and what is kept?' },
  { value: 'RETURN', label: 'Returns', help: 'May delivered goods be returned, and for how much?' },
  { value: 'FLAG_AT_RISK', label: 'Flag as late', help: 'When is an open part flagged for follow-up?' },
  { value: 'AUTO_CANCEL', label: 'Cancel automatically', help: 'When does the system cancel a part by itself, and refund it?' },
];
const GROUPS = [['GOODS', 'Delivery'], ['INSTALL', 'Installation'], ['ACTIVATION', 'Services'], ['ANY', 'Any part']] as const;
const groupName = (g: string) => GROUPS.find(([k]) => k === g)?.[1] ?? g;
const NEW_RULE = (action: string): Rule => ({ id: '', name: '', action, group: action === 'RETURN' ? 'GOODS' : 'INSTALL', priority: 0, enabled: true, when: [{ fact: 'groupStatus', op: 'eq', value: 'PENDING' }], outcome: { allow: true }, showInTerms: true });
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

/**
 * Settings → Cancellation. Every cancellation, return and automatic-cancellation decision comes from these rules: the first enabled rule, from the top,
 * whose part and conditions fit, decides. Changes apply to every order straight away and are recorded in the audit log.
 */
export function CancellationSettings() {
  const view = useApi<View>('/settings/cancellation');
  const [action, setAction] = useState('CANCEL');
  const [editing, setEditing] = useState<Rule | null>(null);
  const [creating, setCreating] = useState(false);
  const act = useAction();
  const apply = (fn: () => Promise<View>) => act.run(async () => { await fn(); await view.reload(); });
  if (view.error) return <Alert>{view.error}</Alert>;
  if (!view.data) return <Spinner />;
  const v = view.data;
  const mine = v.rules.filter((r) => r.action === action).sort((a, b) => a.priority - b.priority);
  const current = ACTIONS.find((a) => a.value === action)!;
  return (
    <div className="space-y-6">
      <Card>
        <p className="text-subhead text-label2">Decide when orders can be cancelled or returned, what it costs, and when the system steps in. Rules are tried from the top; <strong className="text-label">the first one that fits decides</strong>. Shipped goods and switched-on services can never be cancelled, whatever the rules say; they can be returned or terminated.</p>
      </Card>
      {act.error && <Alert>{act.error}</Alert>}

      <section aria-label="Rules">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <Segmented label="What the rules decide" value={action} options={ACTIONS.map((a) => ({ value: a.value, label: a.label }))} onChange={setAction} />
          <Button onClick={() => { setEditing(NEW_RULE(action)); setCreating(true); }}>＋ New rule</Button>
        </div>
        <p className="mb-2 px-1 text-subhead text-label2">{current.help}</p>
        {mine.length === 0 ? <p className="rounded-card bg-surface px-4 py-8 text-center text-subhead text-label2 shadow-card">No rules here. {action === 'CANCEL' || action === 'RETURN' ? `Everything falls back to “${v.settings.defaultAllow ? 'allow' : 'refuse'}” below.` : 'Nothing happens automatically.'}</p> : (
          <ol className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {mine.map((r, i) => (
              <li key={r.id} className={`flex flex-wrap items-start gap-3 px-4 py-3 ${r.enabled ? '' : 'opacity-60'}`}>
                <span aria-hidden className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface2 text-footnote font-semibold tabular-nums text-label2">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">{r.name}<Badge>{groupName(r.group)}</Badge>
                    {r.action !== 'FLAG_AT_RISK' && <Badge tone={r.outcome.allow ? 'success' : 'danger'}>{r.outcome.allow ? (r.outcome.requiresOverride ? 'Needs approval' : r.action === 'RETURN' ? 'Allowed' : 'Allowed') : 'Refused'}</Badge>}
                    {!r.enabled && <Badge tone="neutral">Off</Badge>}</p>
                  <p className="text-subhead text-label2">{v.descriptions[r.id]}</p>
                  {r.message && <p className="mt-0.5 text-footnote text-label2">Customer is told: “{r.message}”</p>}
                </div>
                <span className="flex shrink-0 items-center gap-1">
                  <Button variant="plain" aria-label={`Move ${r.name} up`} disabled={i === 0 || act.busy} className="!min-h-[36px] !px-2" onClick={() => apply(() => post(`/settings/cancellation/rules/${r.id}/move`, { direction: 'up' }))}>↑</Button>
                  <Button variant="plain" aria-label={`Move ${r.name} down`} disabled={i === mine.length - 1 || act.busy} className="!min-h-[36px] !px-2" onClick={() => apply(() => post(`/settings/cancellation/rules/${r.id}/move`, { direction: 'down' }))}>↓</Button>
                  <Button variant="secondary" className="!min-h-[36px] !px-3 !text-subhead" onClick={() => apply(() => patch(`/settings/cancellation/rules/${r.id}`, { ...r, enabled: !r.enabled }))}>{r.enabled ? 'Turn off' : 'Turn on'}</Button>
                  <Button variant="secondary" className="!min-h-[36px] !px-3 !text-subhead" onClick={() => { setEditing(r); setCreating(false); }}>Edit</Button>
                  <Button variant="plain" className="!min-h-[36px] !px-2 text-danger" aria-label={`Delete ${r.name}`} onClick={() => { if (confirm(`Delete “${r.name}”?`)) void apply(() => del(`/settings/cancellation/rules/${r.id}`)); }}>Delete</Button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Card>
        <h2 className="mb-1 text-title3 font-semibold">When no rule fits</h2>
        <p className="mb-3 text-subhead text-label2">A situation none of the rules above covers (for example after you delete a rule).</p>
        <Segmented label="Fallback" value={v.settings.defaultAllow ? 'allow' : 'refuse'} options={[{ value: 'refuse', label: 'Refuse' }, { value: 'allow', label: 'Allow with a full refund' }]} onChange={(m) => apply(() => post('/settings/cancellation/default', { defaultAllow: m === 'allow' }))} />
      </Card>

      <Simulator v={v} />

      <div className="flex sm:justify-end">
        <Button className="w-full sm:w-auto" variant="secondary" onClick={() => { if (confirm('Replace every rule with the standard policy? Your own rules are removed.')) void apply(() => post('/settings/cancellation/reset')); }}>Restore the standard policy</Button>
      </div>

      {editing && <RuleEditor v={v} rule={editing} creating={creating} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void view.reload(); }} />}
    </div>
  );
}

function ValueInput({ fact, cond, onChange }: { fact: FactMeta; cond: Cond; onChange: (c: Cond) => void }) {
  const set = (value: any) => onChange({ ...cond, value });
  if (fact.type === 'number') {
    const money = fact.unit === 'minor units';
    return <div className="flex items-center gap-2"><Input type="number" min="0" step={money ? step() : '1'} aria-label="Value" value={money ? toInput(Number(cond.value) || 0) : cond.value ?? ''} onChange={(e) => set(e.target.value === '' ? '' : money ? toMinor(e.target.value) : Number(e.target.value))} />{fact.unit && !money && <span className="text-subhead text-label2">{fact.unit}</span>}</div>;
  }
  if (fact.type === 'bool') return <Select aria-label="Value" value={String(cond.value)} onChange={(e) => set(e.target.value === 'true')}><option value="true">Yes</option><option value="false">No</option></Select>;
  if (fact.type === 'text') return cond.op === 'in' || cond.op === 'not_in'
    ? <Input aria-label="Value" placeholder="SG, MY" value={Array.isArray(cond.value) ? cond.value.join(', ') : ''} onChange={(e) => set(e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))} />
    : <Input aria-label="Value" value={cond.value ?? ''} onChange={(e) => set(e.target.value)} />;
  if (cond.op === 'in' || cond.op === 'not_in') {
    const sel: string[] = Array.isArray(cond.value) ? cond.value : [];
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {fact.values?.map(([k, l]) => <label key={k} className="flex min-h-[32px] items-center gap-2 text-subhead"><input type="checkbox" className="h-4 w-4 shrink-0 accent-[rgb(var(--accent))]" checked={sel.includes(k)} onChange={(e) => set(e.target.checked ? [...sel, k] : sel.filter((x) => x !== k))} />{label(l)}</label>)}
      </div>
    );
  }
  return <Select aria-label="Value" value={String(cond.value ?? '')} onChange={(e) => set(e.target.value)}>{fact.values?.map(([k, l]) => <option key={k} value={k}>{label(l)}</option>)}</Select>;
}

function RuleEditor({ v, rule, creating, onClose, onSaved }: { v: View; rule: Rule; creating: boolean; onClose: () => void; onSaved: () => void }) {
  const [r, setR] = useState<Rule>(rule);
  const [named, setNamed] = useState(!creating);
  const act = useAction();
  const fact = (id: string) => v.facts.find((f) => f.id === id)!;
  const set = (patch: Partial<Rule>) => setR((x) => ({ ...x, ...patch }));
  const out = (patch: any) => setR((x) => ({ ...x, outcome: { ...x.outcome, ...patch } }));
  const setCond = (i: number, c: Cond) => set({ when: r.when.map((x, k) => (k === i ? c : x)) });
  const addCond = () => set({ when: [...r.when, { fact: 'daysOpen', op: 'gte', value: 1 }] });
  const withId = { ...r, id: creating ? slug(r.name) : r.id };
  const draft = useDebounced(JSON.stringify(withId), 300);
  const [preview, setPreview] = useState<{ errors: string[]; sentence: string } | null>(null);
  useEffect(() => { api('/settings/cancellation/preview', { method: 'POST', json: JSON.parse(draft) }).then(setPreview).catch(() => setPreview(null)); }, [draft]);
  const decides = r.action === 'CANCEL' || r.action === 'RETURN';
  const changeFact = (i: number, id: string) => {
    const f = fact(id); const op = v.ops.find((o) => o.types.includes(f.type))!.id;
    setCond(i, { fact: id, op, value: f.type === 'number' ? 0 : f.type === 'bool' ? true : f.type === 'text' ? '' : f.values?.[0]?.[0] ?? '' });
  };
  const changeOp = (i: number, op: string) => {
    const c = r.when[i]!; const f = fact(c.fact); const multi = op === 'in' || op === 'not_in';
    setCond(i, { ...c, op, value: multi ? (Array.isArray(c.value) ? c.value : c.value ? [c.value] : []) : Array.isArray(c.value) ? c.value[0] ?? (f.values?.[0]?.[0] ?? '') : c.value });
  };
  const save = async () => {
    const body = { ...withId, outcome: { ...r.outcome, ...(r.action === 'FLAG_AT_RISK' ? { allow: true } : {}) } };
    const ok = await act.run(() => (creating ? post('/settings/cancellation/rules', body) : patch(`/settings/cancellation/rules/${r.id}`, body)));
    if (ok) onSaved();
  };
  return (
    <Modal title={creating ? 'New rule' : 'Edit rule'} onClose={onClose} wide>
      <div className="space-y-5">
        {act.error && <Alert>{act.error}</Alert>}
        <Field label="Name" hint="Shown in this list and in the audit log."><Input value={r.name} onChange={(e) => { set({ name: e.target.value }); setNamed(true); }} maxLength={120} autoFocus /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Decides"><Select value={r.action} disabled={!creating} onChange={(e) => set({ action: e.target.value, outcome: e.target.value === 'FLAG_AT_RISK' ? { allow: true } : r.outcome })}>{ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</Select></Field>
          <Field label="Applies to"><Select value={r.group} onChange={(e) => set({ group: e.target.value })}>{GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        </div>

        <fieldset>
          <legend className="mb-1 text-subhead font-medium">When all of these are true</legend>
          <div className="space-y-2">
            {r.when.length === 0 && <p className="text-subhead text-label2">No conditions: the rule fits every situation for this part.</p>}
            {r.when.map((c, i) => {
              const f = fact(c.fact);
              return (
                <div key={i} className="grid gap-2 rounded-control bg-surface2 p-2 sm:grid-cols-[1.4fr_1fr_1.6fr_auto] sm:items-center">
                  <Select aria-label="Condition" value={c.fact} onChange={(e) => changeFact(i, e.target.value)}>{v.facts.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>
                  <Select aria-label="Comparison" value={c.op} onChange={(e) => changeOp(i, e.target.value)}>{v.ops.filter((o) => o.types.includes(f.type)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
                  <ValueInput fact={f} cond={c} onChange={(n) => setCond(i, n)} />
                  <Button type="button" variant="plain" aria-label="Remove condition" className="!min-h-[36px] text-danger" onClick={() => set({ when: r.when.filter((_, k) => k !== i) })}>Remove</Button>
                  <p className="text-caption text-label2 sm:col-span-4">{f.help}</p>
                </div>
              );
            })}
          </div>
          <Button type="button" variant="secondary" className="mt-2 !min-h-[36px] !px-3 !text-subhead" onClick={addCond}>＋ Add a condition</Button>
        </fieldset>

        {r.action !== 'FLAG_AT_RISK' && (
          <fieldset>
            <legend className="mb-1 text-subhead font-medium">Then</legend>
            <Segmented label="Outcome" value={r.outcome.allow ? 'allow' : 'refuse'} options={[{ value: 'allow', label: r.action === 'AUTO_CANCEL' ? 'Cancel it' : 'Allow' }, { value: 'refuse', label: 'Refuse' }]} onChange={(m) => out(m === 'refuse' ? { allow: false, feeFixedMinor: undefined, feePercentBps: undefined, feeMinMinor: undefined, feeMaxMinor: undefined, requiresOverride: undefined } : { allow: true })} />
            {r.outcome.allow && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label={`Fixed fee kept (${v.currency})`} hint="Taken from the refund."><Input type="number" min="0" step={step()} value={r.outcome.feeFixedMinor ? toInput(r.outcome.feeFixedMinor) : ''} onChange={(e) => out({ feeFixedMinor: e.target.value ? toMinor(e.target.value) : undefined })} /></Field>
                <Field label="Percent of what was paid kept" hint="Added to the fixed fee."><Input type="number" min="0" max="100" step="0.01" value={r.outcome.feePercentBps ? r.outcome.feePercentBps / 100 : ''} onChange={(e) => out({ feePercentBps: e.target.value ? Math.round(Number(e.target.value) * 100) : undefined })} /></Field>
                <Field label="Percent refunded" hint="100 refunds everything; use less for restocking charges."><Input type="number" min="0" max="100" step="0.01" value={r.outcome.refundBps === undefined ? '' : r.outcome.refundBps / 100} placeholder="100" onChange={(e) => out({ refundBps: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100) })} /></Field>
                {r.action === 'RETURN' && <Field label="Most that may be deducted for damage (percent)" hint="The person handling a return can deduct up to this share."><Input type="number" min="0" max="100" step="0.01" value={r.outcome.maxDeductionBps === undefined ? '' : r.outcome.maxDeductionBps / 100} placeholder="100" onChange={(e) => out({ maxDeductionBps: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100) })} /></Field>}
                {decides && <label className="flex min-h-tap items-center gap-3 sm:col-span-2"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={!!r.outcome.requiresOverride} onChange={(e) => out({ requiresOverride: e.target.checked || undefined })} />Only with a supervisor’s approval</label>}
              </div>
            )}
          </fieldset>
        )}

        {decides || r.action === 'AUTO_CANCEL' ? (
          <>
            <Field label="What the customer is told (optional)" hint="Leave blank to use the sentence below."><Input value={r.message ?? ''} maxLength={300} onChange={(e) => set({ message: e.target.value })} /></Field>
            <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={r.showInTerms} onChange={(e) => set({ showInTerms: e.target.checked })} />Show this in the order terms customers see</label>
          </>
        ) : null}

        <div className="rounded-control bg-accent/8 p-3" aria-live="polite">
          <p className="text-footnote font-semibold uppercase tracking-wide text-accent">In plain words</p>
          <p className="text-subhead">{preview?.sentence || '…'}</p>
          {preview?.errors.map((e) => <p key={e} className="mt-1 text-footnote text-danger">{e}</p>)}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={act.busy || !named || !r.name.trim() || (preview?.errors.length ?? 0) > 0}>{act.busy ? 'Saving…' : 'Save rule'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function Simulator({ v }: { v: View }) {
  const [s, setS] = useState({ action: 'CANCEL', group: 'INSTALL', groupStatus: 'PENDING', hoursToVisit: '', daysOpen: '', daysSinceDelivered: '', channel: '', initiatedBy: 'STAFF', returnCondition: 'GOOD', paid: '100', canOverride: false });
  const [res, setRes] = useState<any>(null);
  const act = useAction();
  const num = (x: string) => (x === '' ? undefined : Number(x));
  const run = () => act.run(async () => {
    const facts: Record<string, any> = { groupStatus: s.groupStatus, initiatedBy: s.initiatedBy };
    if (num(s.hoursToVisit) !== undefined) facts.hoursToVisit = num(s.hoursToVisit);
    if (num(s.daysOpen) !== undefined) { facts.daysOpen = num(s.daysOpen); facts.hoursOpen = (num(s.daysOpen) as number) * 24; }
    if (num(s.daysSinceDelivered) !== undefined) facts.daysSinceDelivered = num(s.daysSinceDelivered);
    if (s.channel) facts.channel = s.channel;
    if (s.action === 'RETURN') facts.returnCondition = s.returnCondition;
    setRes(await post('/settings/cancellation/simulate', { action: s.action, group: s.group, facts, paidMinor: toMinor(s.paid || '0'), canOverride: s.canOverride }));
  });
  const status = v.facts.find((f) => f.id === 'groupStatus')!;
  const channel = v.facts.find((f) => f.id === 'channel')!;
  return (
    <Card>
      <h2 className="mb-1 text-title3 font-semibold">Try it</h2>
      <p className="mb-4 text-subhead text-label2">Describe a situation and see which rule decides, what it refunds, and why the rules above it did not apply.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Question"><Select value={s.action} onChange={(e) => setS({ ...s, action: e.target.value, groupStatus: e.target.value === 'RETURN' ? 'DONE' : 'PENDING', group: e.target.value === 'RETURN' ? 'GOODS' : s.group })}>{ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</Select></Field>
        <Field label="Part"><Select value={s.group} onChange={(e) => setS({ ...s, group: e.target.value })}>{GROUPS.filter(([k]) => k !== 'ANY').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Where it is"><Select value={s.groupStatus} onChange={(e) => setS({ ...s, groupStatus: e.target.value })}>{status.values!.map(([k, l]) => <option key={k} value={k}>{label(l)}</option>)}</Select></Field>
        {s.group === 'INSTALL' && <Field label="Hours until the visit" hint="Blank = no visit booked"><Input type="number" value={s.hoursToVisit} onChange={(e) => setS({ ...s, hoursToVisit: e.target.value })} /></Field>}
        {s.group === 'GOODS' && s.groupStatus === 'DONE' && <Field label="Days since delivery"><Input type="number" value={s.daysSinceDelivered} onChange={(e) => setS({ ...s, daysSinceDelivered: e.target.value })} /></Field>}
        <Field label="Days since the order was paid"><Input type="number" value={s.daysOpen} onChange={(e) => setS({ ...s, daysOpen: e.target.value })} /></Field>
        <Field label="Sales channel"><Select value={s.channel} onChange={(e) => setS({ ...s, channel: e.target.value })}><option value="">Any</option>{channel.values!.map(([k, l]) => <option key={k} value={k}>{label(l)}</option>)}</Select></Field>
        <Field label="Who is acting"><Select value={s.initiatedBy} onChange={(e) => setS({ ...s, initiatedBy: e.target.value })}><option value="STAFF">A staff member</option><option value="CUSTOMER">The customer</option><option value="SYSTEM">The system</option></Select></Field>
        {s.action === 'RETURN' && <Field label="Condition"><Select value={s.returnCondition} onChange={(e) => setS({ ...s, returnCondition: e.target.value })}><option value="GOOD">As new</option><option value="DAMAGED">Damaged</option><option value="INCOMPLETE">Missing parts</option></Select></Field>}
        <Field label={`Amount paid for this part (${v.currency})`}><Input type="number" min="0" step={step()} value={s.paid} onChange={(e) => setS({ ...s, paid: e.target.value })} /></Field>
        <label className="flex min-h-tap items-center gap-3 sm:self-end"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={s.canOverride} onChange={(e) => setS({ ...s, canOverride: e.target.checked })} />Person has override approval</label>
      </div>
      <div className="mt-4"><Button onClick={run} disabled={act.busy}>{act.busy ? 'Working…' : 'See what happens'}</Button></div>
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
      {res && (
        <div className="mt-4 space-y-3" aria-live="polite">
          <div className={`rounded-control p-3 ${res.decision.allow ? 'bg-success/10' : 'bg-danger/10'}`}>
            <p className="font-semibold">{res.decision.allow ? (s.action === 'FLAG_AT_RISK' ? 'It is flagged.' : 'Allowed') : res.decision.needsOverride ? 'Needs a supervisor’s approval' : 'Not allowed'}{res.decision.rule && <span className="font-normal text-label2"> · decided by “{res.decision.rule.name}”</span>}</p>
            <p className="text-subhead">{res.decision.summary}</p>
            {res.decision.allow && s.action !== 'FLAG_AT_RISK' && <p className="mt-1 text-subhead">Refund {toInput(res.decision.refundMinor)} {v.currency}, keeping {toInput(res.decision.retainedMinor)}.</p>}
          </div>
          <details><summary className="cursor-pointer text-subhead text-accent">How the rules were tried</summary>
            <ol className="mt-2 space-y-1 text-subhead">{res.trace.map((t: any) => <li key={t.id} className={t.matched ? 'font-medium' : 'text-label2'}>{t.matched ? '✓' : '·'} {t.name}{t.reason ? ` — ${t.reason}` : t.matched ? ' — matched' : ''}</li>)}</ol></details>
        </div>
      )}
    </Card>
  );
}
