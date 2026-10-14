'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, Modal, SectionTitle, Select, Spinner, Textarea } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { label, money, toInput, toMinor } from '@/lib/format';

const pct = (bps: number | null | undefined) => (bps == null ? '' : String(bps / 100));
const bps = (v: string) => Math.round(parseFloat(v || '0') * 100);
const termText = (r: any) => (r.minTermMonths == null && r.maxTermMonths == null ? 'Any contract' : r.maxTermMonths === 0 && !r.minTermMonths ? 'SIM only' : `${r.minTermMonths ?? 0}${r.maxTermMonths == null ? '+' : `–${r.maxTermMonths}`} months`);
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

interface RuleDraft { name: string; priority: string; kinds: string; offers: string; min: string; max: string; tiers: string[]; calc: 'PERCENT' | 'FIXED'; rate: string; fixed: string; slabMode: 'MARGINAL' | 'RETROACTIVE'; slabs: Array<{ from: string; to: string; rate: string; fixed: string; bonus: string }>; status: 'ACTIVE' | 'INACTIVE' }
const blankRule = (): RuleDraft => ({ name: '', priority: '100', kinds: '', offers: '', min: '', max: '', tiers: [], calc: 'PERCENT', rate: '5', fixed: '', slabMode: 'MARGINAL', slabs: [], status: 'ACTIVE' });
const fromRule = (r: any): RuleDraft => ({ name: r.name, priority: String(r.priority), kinds: r.matchKinds.join(', '), offers: r.matchOfferIds.join(', '), min: r.minTermMonths == null ? '' : String(r.minTermMonths), max: r.maxTermMonths == null ? '' : String(r.maxTermMonths), tiers: r.matchTiers, calc: r.calc, rate: pct(r.rateBps), fixed: r.fixedMinor ? toInput(r.fixedMinor) : '', slabMode: r.slabMode, status: r.status,
  slabs: r.slabs.map((s: any) => ({ from: String(s.from), to: s.to == null ? '' : String(s.to), rate: pct(s.rateBps), fixed: s.fixedMinor ? toInput(s.fixedMinor) : '', bonus: s.bonusMinor ? toInput(s.bonusMinor) : '' })) });
const ruleBody = (x: RuleDraft) => ({
  name: x.name, priority: Number(x.priority) || 100, matchKinds: list(x.kinds), matchOfferIds: list(x.offers), minTermMonths: x.min === '' ? null : Number(x.min), maxTermMonths: x.max === '' ? null : Number(x.max), matchTiers: x.tiers,
  calc: x.calc, rateBps: x.calc === 'PERCENT' ? bps(x.rate) : 0, fixedMinor: x.calc === 'FIXED' && x.fixed ? toMinor(x.fixed) : 0, slabMode: x.slabMode, status: x.status,
  slabs: x.slabs.filter((s) => s.from).map((s) => ({ from: Number(s.from), to: s.to === '' ? null : Number(s.to), ...(x.calc === 'PERCENT' && s.rate !== '' ? { rateBps: bps(s.rate) } : {}), ...(x.calc === 'FIXED' && s.fixed ? { fixedMinor: toMinor(s.fixed) } : {}), ...(s.bonus ? { bonusMinor: toMinor(s.bonus) } : {}) })),
});
interface PolicyDraft { name: string; min: string; triggers: string[]; tiers: Array<{ days: string; pct: string }>; overrides: boolean; status: 'ACTIVE' | 'INACTIVE' }
const blankPolicy = (): PolicyDraft => ({ name: '', min: '', triggers: ['TERMINATION', 'PORT_OUT', 'ORDER_CANCELLED'], tiers: [{ days: '90', pct: '100' }], overrides: true, status: 'ACTIVE' });

/** Commission plans: rules by product and contract, volume bands, claw-back policies and who earns by which plan. */
export function Plans() {
  const plans = useApi<{ items: any[] }>('/commission/plans');
  const meta = useApi<any>('/commission/meta');
  const [planEdit, setPlanEdit] = useState<any | null>(null);
  const [rule, setRule] = useState<{ planId: string; id: string | null; d: RuleDraft } | null>(null);
  const [policy, setPolicy] = useState<{ planId: string; id: string | null; d: PolicyDraft } | null>(null);
  const [assign, setAssign] = useState<{ planId: string; kind: string; actorId: string } | null>(null);
  const [sim, setSim] = useState({ dealerId: '', channel: 'RETAIL_ASSISTED', offerKind: 'PLAN', termMonths: '24', quantity: '1', basis: '100', countBefore: '0' });
  const [simOut, setSimOut] = useState<any | null>(null);
  const act = useAction(plans.reload);
  const simAct = useAction();
  if (plans.error) return <Alert>{plans.error}</Alert>;
  if (!plans.data || !meta.data) return <Spinner />;
  const setR = (k: keyof RuleDraft, v: unknown) => setRule((x) => (x ? { ...x, d: { ...x.d, [k]: v } } : x));
  const setSlab = (i: number, k: string, v: string) => setRule((x) => (x ? { ...x, d: { ...x.d, slabs: x.d.slabs.map((s, n) => (n === i ? { ...s, [k]: v } : s)) } } : x));

  return (
    <div className="space-y-6">
      <Card>
        <SectionTitle>Try a sale</SectionTitle>
        <div className="form-row">
          <Field label="Dealer ID" hint="Blank to use a channel"><Input className="font-mono" value={sim.dealerId} onChange={(e) => setSim({ ...sim, dealerId: e.target.value })} /></Field>
          <Field label="Offer kind"><Input value={sim.offerKind} onChange={(e) => setSim({ ...sim, offerKind: e.target.value })} /></Field>
          <Field label="Contract months"><Input type="number" min={0} value={sim.termMonths} onChange={(e) => setSim({ ...sim, termMonths: e.target.value })} /></Field>
          <Field label="Activations"><Input type="number" min={1} value={sim.quantity} onChange={(e) => setSim({ ...sim, quantity: e.target.value })} /></Field>
          <Field label="Sale value"><Input inputMode="decimal" value={sim.basis} onChange={(e) => setSim({ ...sim, basis: e.target.value })} /></Field>
          <Field label="Activations so far this month"><Input type="number" min={0} value={sim.countBefore} onChange={(e) => setSim({ ...sim, countBefore: e.target.value })} /></Field>
        </div>
        <div className="mt-3"><Button variant="secondary" disabled={simAct.busy} onClick={() => simAct.run(async () => setSimOut(await post('/commission/preview', { ...(sim.dealerId ? { dealerId: sim.dealerId } : { channel: sim.channel }), offerKind: sim.offerKind, termMonths: Number(sim.termMonths), quantity: Number(sim.quantity), basisMinor: toMinor(sim.basis), countBefore: Number(sim.countBefore) })))}>What would it earn?</Button></div>
        {simAct.error && <div className="mt-3"><Alert>{simAct.error}</Alert></div>}
        {simOut && (simOut.plan ? <div className="mt-3"><Alert tone="success">Plan “{simOut.plan.name}”: {simOut.entries.length ? simOut.entries.map((e: any) => `${label(e.entryType)} ${money(e.amountMinor)}${e.entryType === 'EARNING' ? ` by rule “${e.calc.rule}”` : ` to ${e.beneficiaryId}`}`).join('; ') : 'no rule covers this sale, so it earns nothing.'}</Alert></div> : <div className="mt-3"><Alert>No plan applies to this seller.</Alert></div>)}
      </Card>

      <SectionTitle action={<Button onClick={() => setPlanEdit({ id: null, name: '', status: 'ACTIVE', holdDays: '0', overrides: '', note: '' })}>Add a plan</Button>}>Plans</SectionTitle>
      {act.error && <Alert>{act.error}</Alert>}
      {plans.data.items.length === 0 && <Empty>No plans yet.</Empty>}
      {plans.data.items.map((p) => (
        <Card key={p.id} className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-headline font-semibold">{p.name} <Badge tone={p.status === 'ACTIVE' ? 'success' : 'neutral'}>{p.status === 'ACTIVE' ? 'Active' : 'Off'}</Badge></p>
              <p className="text-footnote text-label2">Earnings are held {p.holdDays} day(s) before approval{p.overrideBps.length ? ` · upline override ${p.overrideBps.map((b: number, i: number) => `L${i + 1} ${pct(b)}%`).join(', ')}` : ''}{p.note ? ` · ${p.note}` : ''}</p></div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setPlanEdit({ id: p.id, name: p.name, status: p.status, holdDays: String(p.holdDays), overrides: p.overrideBps.map((b: number) => pct(b)).join(', '), note: p.note ?? '' })}>Edit plan</Button>
              <Button variant="plain" disabled={act.busy} onClick={() => { if (window.confirm(p.entries ? `“${p.name}” has earned commission, so it will be switched off, not removed.` : `Remove “${p.name}”?`)) void act.run(() => (p.entries ? patch(`/commission/plans/${p.id}`, { name: p.name, status: 'INACTIVE', holdDays: p.holdDays, overrideBps: p.overrideBps, note: p.note }) : del(`/commission/plans/${p.id}`))); }}>{p.entries ? 'Switch off' : 'Remove'}</Button>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between"><p className="font-medium">Rules</p><Button variant="secondary" onClick={() => setRule({ planId: p.id, id: null, d: blankRule() })}>Add a rule</Button></div>
            {p.rules.length === 0 ? <Empty>No rules: this plan pays nothing yet.</Empty> : (
              <DataList label={`Rules of ${p.name}`} rows={p.rules} rowKey={(r: any) => r.id}
                columns={[
                  { key: 'n', label: 'Rule', primary: true, render: (r: any) => <span className="font-medium">{r.name}</span> },
                  { key: 'm', label: 'Applies to', render: (r: any) => [r.matchKinds.length ? r.matchKinds.join(', ') : null, r.matchOfferIds.length ? `${r.matchOfferIds.length} offer(s)` : null, termText(r), r.matchTiers.length ? r.matchTiers.map(label).join(', ') : null].filter(Boolean).join(' · ') },
                  { key: 'p', label: 'Pays', render: (r: any) => (r.calc === 'PERCENT' ? `${pct(r.rateBps)}% of sale value` : `${money(r.fixedMinor)} per activation`) },
                  { key: 's', label: 'Volume bands', render: (r: any) => (r.slabs.length ? `${r.slabs.map((s: any) => `${s.from}–${s.to ?? '∞'}: ${r.calc === 'PERCENT' ? `${pct(s.rateBps ?? r.rateBps)}%` : money(s.fixedMinor ?? r.fixedMinor)}${s.bonusMinor ? ` +${money(s.bonusMinor)}` : ''}`).join(' · ')} (${r.slabMode === 'RETROACTIVE' ? 'retroactive' : 'marginal'})` : '—') },
                  { key: 'st', label: 'Status', render: (r: any) => <Badge tone={r.status === 'ACTIVE' ? 'success' : 'neutral'}>{r.status === 'ACTIVE' ? 'Active' : 'Off'}</Badge> },
                ]}
                actions={(r: any) => (<><Button variant="secondary" onClick={() => setRule({ planId: p.id, id: r.id, d: fromRule(r) })}>Edit</Button><Button variant="plain" disabled={act.busy} onClick={() => { if (window.confirm(`Remove “${r.name}”?`)) void act.run(() => del(`/commission/plans/${p.id}/rules/${r.id}`)); }}>Remove</Button></>)} />
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between"><p className="font-medium">Claw-back policies</p><Button variant="secondary" onClick={() => setPolicy({ planId: p.id, id: null, d: blankPolicy() })}>Add a policy</Button></div>
            {p.clawbacks.length === 0 ? <p className="text-footnote text-label2">No policy: commission is never taken back.</p> : (
              <DataList label={`Claw-backs of ${p.name}`} rows={p.clawbacks} rowKey={(c: any) => c.id}
                columns={[
                  { key: 'n', label: 'Policy', primary: true, render: (c: any) => <span className="font-medium">{c.name}</span> },
                  { key: 'w', label: 'Windows', render: (c: any) => c.tiers.map((t: any) => `${t.withinDays} days: ${pct(t.percentBps)}%`).join(' · ') },
                  { key: 't', label: 'When', render: (c: any) => c.triggers.map(label).join(', ') },
                  { key: 'c', label: 'Contracts', render: (c: any) => (c.minTermMonths ? `${c.minTermMonths}+ months` : 'All') },
                  { key: 'st', label: 'Status', render: (c: any) => <Badge tone={c.status === 'ACTIVE' ? 'success' : 'neutral'}>{c.status === 'ACTIVE' ? 'Active' : 'Off'}</Badge> },
                ]}
                actions={(c: any) => (<><Button variant="secondary" onClick={() => setPolicy({ planId: p.id, id: c.id, d: { name: c.name, min: c.minTermMonths == null ? '' : String(c.minTermMonths), triggers: c.triggers, tiers: c.tiers.map((t: any) => ({ days: String(t.withinDays), pct: pct(t.percentBps) })), overrides: c.includeOverrides, status: c.status } })}>Edit</Button><Button variant="plain" disabled={act.busy} onClick={() => { if (window.confirm(`Remove “${c.name}”?`)) void act.run(() => del(`/commission/plans/${p.id}/policies/${c.id}`)); }}>Remove</Button></>)} />
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between"><p className="font-medium">Who earns by this plan</p><Button variant="secondary" onClick={() => setAssign({ planId: p.id, kind: 'DEALER', actorId: '' })}>Assign</Button></div>
            {p.assignments.length === 0 ? <p className="text-footnote text-label2">Nobody yet.</p> : (
              <div className="flex flex-wrap gap-2">{p.assignments.map((a: any) => (
                <span key={a.id} className="inline-flex items-center gap-2 rounded-full bg-surface2 px-3 py-1.5 text-subhead">{label(a.kind)} <span className="font-mono">{a.actorId}</span>
                  <button aria-label={`Remove ${a.actorId}`} className="text-label2" onClick={() => act.run(() => del(`/commission/assignments/${a.id}`))}>✕</button></span>))}</div>
            )}
          </div>
        </Card>
      ))}

      {planEdit && (
        <Modal title={planEdit.id ? 'Edit plan' : 'Add a plan'} onClose={() => setPlanEdit(null)}>
          <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); const body = { name: planEdit.name, status: planEdit.status, holdDays: Number(planEdit.holdDays) || 0, overrideBps: list(planEdit.overrides).map(bps), note: planEdit.note || null }; if (await act.run(() => (planEdit.id ? patch(`/commission/plans/${planEdit.id}`, body) : post('/commission/plans', body)))) setPlanEdit(null); }}>
            <Field label="Name"><Input value={planEdit.name} maxLength={120} required onChange={(e) => setPlanEdit({ ...planEdit, name: e.target.value })} /></Field>
            <Field label="Hold before approval (days)" hint="How long an earning waits, for example until the claw-back window has passed"><Input type="number" min={0} max={365} value={planEdit.holdDays} onChange={(e) => setPlanEdit({ ...planEdit, holdDays: e.target.value })} /></Field>
            <Field label="Upline override (%)" hint="What the dealer above, then the one above that, earns on the same sale. For example 1, 0.5"><Input value={planEdit.overrides} onChange={(e) => setPlanEdit({ ...planEdit, overrides: e.target.value })} /></Field>
            <Field label="Status"><Select value={planEdit.status} onChange={(e) => setPlanEdit({ ...planEdit, status: e.target.value })}><option value="ACTIVE">Active</option><option value="INACTIVE">Off</option></Select></Field>
            <Field label="Note"><Textarea rows={2} maxLength={500} value={planEdit.note} onChange={(e) => setPlanEdit({ ...planEdit, note: e.target.value })} /></Field>
            {act.error && <Alert>{act.error}</Alert>}
            <div className="flex justify-end gap-2"><Button type="button" variant="plain" onClick={() => setPlanEdit(null)}>Cancel</Button><Button type="submit" disabled={act.busy}>Save plan</Button></div>
          </form>
        </Modal>
      )}

      {rule && (
        <Modal title={rule.id ? 'Edit rule' : 'Add a rule'} wide onClose={() => setRule(null)}>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); const b = ruleBody(rule.d); if (await act.run(() => (rule.id ? patch(`/commission/plans/${rule.planId}/rules/${rule.id}`, b) : post(`/commission/plans/${rule.planId}/rules`, b)))) setRule(null); }}>
            <div className="sm:col-span-2"><Field label="Name"><Input value={rule.d.name} maxLength={120} required onChange={(e) => setR('name', e.target.value)} /></Field></div>
            <Field label="Offer kinds" hint="Comma separated. Blank = any"><Input value={rule.d.kinds} onChange={(e) => setR('kinds', e.target.value)} /></Field>
            <Field label="Specific offers" hint="Offer IDs, comma separated. Blank = any"><Input className="font-mono" value={rule.d.offers} onChange={(e) => setR('offers', e.target.value)} /></Field>
            <Field label="Contract at least (months)" hint="0 = SIM only. Blank = no limit"><Input type="number" min={0} value={rule.d.min} onChange={(e) => setR('min', e.target.value)} /></Field>
            <Field label="Contract at most (months)" hint="Blank = no limit"><Input type="number" min={0} value={rule.d.max} onChange={(e) => setR('max', e.target.value)} /></Field>
            <div className="sm:col-span-2"><p className="mb-1 text-subhead font-medium">Seller tiers <span className="font-normal text-label2">(none ticked = all)</span></p>
              <div className="flex flex-wrap gap-4">{meta.data.tiers.map((t: string) => <label key={t} className="inline-flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={rule.d.tiers.includes(t)} onChange={(e) => setR('tiers', e.target.checked ? [...rule.d.tiers, t] : rule.d.tiers.filter((x) => x !== t))} />{label(t)}</label>)}</div></div>
            <Field label="Pays"><Select value={rule.d.calc} onChange={(e) => setR('calc', e.target.value)}><option value="PERCENT">A percentage of the sale value</option><option value="FIXED">A fixed amount per activation</option></Select></Field>
            {rule.d.calc === 'PERCENT' ? <Field label="Base rate (%)"><Input inputMode="decimal" value={rule.d.rate} onChange={(e) => setR('rate', e.target.value)} /></Field> : <Field label="Base amount per activation"><Input inputMode="decimal" value={rule.d.fixed} onChange={(e) => setR('fixed', e.target.value)} /></Field>}
            <Field label="Priority" hint="Lower wins between equally specific rules"><Input type="number" min={0} value={rule.d.priority} onChange={(e) => setR('priority', e.target.value)} /></Field>
            <Field label="Status"><Select value={rule.d.status} onChange={(e) => setR('status', e.target.value)}><option value="ACTIVE">Active</option><option value="INACTIVE">Off</option></Select></Field>
            <div className="sm:col-span-2 space-y-2 rounded-card bg-surface2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">Volume bands <span className="font-normal text-label2">(activations per month)</span></p>
                <Select aria-label="How bands apply" className="!w-auto" value={rule.d.slabMode} onChange={(e) => setR('slabMode', e.target.value)}><option value="MARGINAL">Each activation earns its own band’s rate</option><option value="RETROACTIVE">Reaching a band lifts the whole month</option></Select></div>
              {rule.d.slabs.map((s, i) => (
                <div key={i} className="form-row [--fr-min:6rem]">
                  <Field label="From"><Input type="number" min={1} value={s.from} onChange={(e) => setSlab(i, 'from', e.target.value)} /></Field>
                  <Field label="To"><Input type="number" min={1} placeholder="and above" value={s.to} onChange={(e) => setSlab(i, 'to', e.target.value)} /></Field>
                  {rule.d.calc === 'PERCENT' ? <Field label="Rate (%)"><Input inputMode="decimal" value={s.rate} onChange={(e) => setSlab(i, 'rate', e.target.value)} /></Field> : <Field label="Amount"><Input inputMode="decimal" value={s.fixed} onChange={(e) => setSlab(i, 'fixed', e.target.value)} /></Field>}
                  <Field label="Bonus on reaching"><Input inputMode="decimal" value={s.bonus} onChange={(e) => setSlab(i, 'bonus', e.target.value)} /></Field>
                  <Button type="button" variant="plain" onClick={() => setR('slabs', rule.d.slabs.filter((_, n) => n !== i))}>Remove</Button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={() => { const last = rule.d.slabs[rule.d.slabs.length - 1]; setR('slabs', [...rule.d.slabs, { from: last?.to ? String(Number(last.to) + 1) : '1', to: '', rate: '', fixed: '', bonus: '' }]); }}>Add a band</Button>
              <p className="text-footnote text-label2">Example: 5% up to 50, 8% from 51 to 100, 12% above 100.</p>
            </div>
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="plain" onClick={() => setRule(null)}>Cancel</Button><Button type="submit" disabled={act.busy}>{act.busy ? 'Saving…' : 'Save rule'}</Button></div>
          </form>
        </Modal>
      )}

      {policy && (
        <Modal title={policy.id ? 'Edit claw-back policy' : 'Add a claw-back policy'} onClose={() => setPolicy(null)}>
          <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); const x = policy.d; const b = { name: x.name, minTermMonths: x.min === '' ? null : Number(x.min), triggers: x.triggers, tiers: x.tiers.filter((t) => t.days).map((t) => ({ withinDays: Number(t.days), percentBps: bps(t.pct) })), includeOverrides: x.overrides, status: x.status }; if (await act.run(() => (policy.id ? patch(`/commission/plans/${policy.planId}/policies/${policy.id}`, b) : post(`/commission/plans/${policy.planId}/policies`, b)))) setPolicy(null); }}>
            <Field label="Name"><Input value={policy.d.name} maxLength={120} required onChange={(e) => setPolicy({ ...policy, d: { ...policy.d, name: e.target.value } })} /></Field>
            <Field label="Contracts of at least (months)" hint="Blank = every contract. The policy with the longest minimum that fits wins"><Input type="number" min={0} value={policy.d.min} onChange={(e) => setPolicy({ ...policy, d: { ...policy.d, min: e.target.value } })} /></Field>
            <div><p className="mb-1 text-subhead font-medium">Takes commission back when</p>
              <div className="flex flex-wrap gap-4">{meta.data.triggers.map((t: string) => <label key={t} className="inline-flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={policy.d.triggers.includes(t)} onChange={(e) => setPolicy({ ...policy, d: { ...policy.d, triggers: e.target.checked ? [...policy.d.triggers, t] : policy.d.triggers.filter((x) => x !== t) } })} />{label(t)}</label>)}</div></div>
            <div className="space-y-2 rounded-card bg-surface2 p-3"><p className="font-medium">Windows</p>
              {policy.d.tiers.map((t, i) => (
                <div key={i} className="form-row [--fr-min:7rem]">
                  <Field label="Within (days)"><Input type="number" min={1} value={t.days} onChange={(e) => setPolicy({ ...policy, d: { ...policy.d, tiers: policy.d.tiers.map((x, n) => (n === i ? { ...x, days: e.target.value } : x)) } })} /></Field>
                  <Field label="Take back (%)"><Input inputMode="decimal" value={t.pct} onChange={(e) => setPolicy({ ...policy, d: { ...policy.d, tiers: policy.d.tiers.map((x, n) => (n === i ? { ...x, pct: e.target.value } : x)) } })} /></Field>
                  <Button type="button" variant="plain" onClick={() => setPolicy({ ...policy, d: { ...policy.d, tiers: policy.d.tiers.filter((_, n) => n !== i) } })}>Remove</Button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={() => setPolicy({ ...policy, d: { ...policy.d, tiers: [...policy.d.tiers, { days: '', pct: '' }] } })}>Add a window</Button>
              <p className="text-footnote text-label2">Example: 30 days at 100%, 90 days at 50%. After the last window nothing is taken back.</p></div>
            <label className="inline-flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={policy.d.overrides} onChange={(e) => setPolicy({ ...policy, d: { ...policy.d, overrides: e.target.checked } })} />Also take back upline override commission</label>
            {act.error && <Alert>{act.error}</Alert>}
            <div className="flex justify-end gap-2"><Button type="button" variant="plain" onClick={() => setPolicy(null)}>Cancel</Button><Button type="submit" disabled={act.busy}>Save policy</Button></div>
          </form>
        </Modal>
      )}

      {assign && (
        <Modal title="Assign this plan" onClose={() => setAssign(null)}>
          <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => post(`/commission/plans/${assign.planId}/assign`, { kind: assign.kind, actorId: assign.actorId }))) setAssign(null); }}>
            <Field label="To"><Select value={assign.kind} onChange={(e) => setAssign({ ...assign, kind: e.target.value, actorId: '' })}>{meta.data.assignmentKinds.map((k: string) => <option key={k} value={k}>{k === 'DEALER' ? 'A dealer (and the dealers beneath it)' : k === 'STAFF' ? 'A salesperson (username)' : k === 'STORE' ? 'A company store' : 'A whole channel'}</option>)}</Select></Field>
            {assign.kind === 'CHANNEL'
              ? <Field label="Channel"><Select value={assign.actorId} onChange={(e) => setAssign({ ...assign, actorId: e.target.value })} required><option value="">Choose…</option>{['RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER', 'SELF_SERVE'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
              : <Field label={assign.kind === 'DEALER' ? 'Dealer ID' : assign.kind === 'STORE' ? 'Store ID' : 'Username'}><Input className="font-mono" value={assign.actorId} onChange={(e) => setAssign({ ...assign, actorId: e.target.value })} required /></Field>}
            <p className="text-footnote text-label2">An actor has one plan: assigning replaces the one it had. Order of precedence: dealer (then its parents), salesperson, store, channel.</p>
            {act.error && <Alert>{act.error}</Alert>}
            <div className="flex justify-end gap-2"><Button type="button" variant="plain" onClick={() => setAssign(null)}>Cancel</Button><Button type="submit" disabled={act.busy}>Assign</Button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}
