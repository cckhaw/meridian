'use client';
import { Alert, Badge, Button, Card, Field, Input, SectionTitle, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { patch, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money, toInput, toMinor } from '@/lib/format';

/** What each VIP tier costs and demands, and the patterns that put a number in it. */
export function TiersPane() {
  const { can } = useAuth();
  const t = useApi<any>('/numbering/tiers');
  const reclass = useAction(t.reload);
  if (t.error) return <Alert>{t.error}</Alert>;
  if (!t.data) return <Spinner />;
  const manage = can('numbering:manage');
  return (
    <>
      <p className="mb-4 text-subhead text-label2">A number is put in a tier by what it ends with. Choosing a VIP number adds its connection fee, needs a plan and contract of at least the amounts shown, and leaving early costs more. Patterns are tried against the last 8 digits.</p>
      <div className="space-y-4">{t.data.tiers.map((r: any) => <TierCard key={r.tier} rule={r} manage={manage} onSaved={t.reload} />)}</div>
      {manage && (
        <div className="mt-4">
          <Button variant="secondary" disabled={reclass.busy} onClick={() => reclass.run(() => post('/numbering/tiers/reclassify', {}), 'Done')}>{reclass.busy ? 'Working…' : 'Put available numbers in their tier again'}</Button>
          <p className="mt-2 text-footnote text-label2">After changing patterns, this re-sorts the numbers that are still available. Sold, reserved and held numbers keep their tier.</p>
          {reclass.error && <div className="mt-2"><Alert>{reclass.error}</Alert></div>}{reclass.ok && <div className="mt-2"><Alert tone="success">Re-sorted: {reclass.ok}</Alert></div>}
        </div>
      )}
      <SectionTitle>Rules</SectionTitle>
      <RulesCard settings={t.data.settings} onSaved={t.reload} />
    </>
  );
}

function TierCard({ rule, manage, onSaved }: { rule: any; manage: boolean; onSaved: () => void }) {
  const [f, setF] = useState({ label: rule.label as string, fee: toInput(rule.oneTimeFeeMinor), plan: toInput(rule.minMonthlyPlanMinor), months: String(rule.minContractMonths), etc: String(rule.etcMultiplierBps / 10000), enabled: rule.enabled as boolean });
  const [patterns, setPatterns] = useState<Array<{ code: string; regex: string }>>(rule.patterns);
  const save = useAction(onSaved);
  const standard = rule.tier === 'STANDARD';
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-title3 font-semibold">{rule.label}</h3><Badge tone={rule.enabled ? 'success' : 'neutral'}>{rule.enabled ? 'On' : 'Off'}</Badge></div>
      <div className="grid gap-3 sm:grid-cols-5">
        <Field label="Name"><Input disabled={!manage} value={f.label} maxLength={40} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <Field label="Connection fee"><Input disabled={!manage || standard} inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} /></Field>
        <Field label="Plan at least, per month"><Input disabled={!manage || standard} inputMode="decimal" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })} /></Field>
        <Field label="Contract at least (months)"><Input disabled={!manage || standard} type="number" min={0} max={60} value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} /></Field>
        <Field label="Early-termination charge ×" hint="1 = normal"><Input disabled={!manage || standard} type="number" min={1} max={10} step={0.05} value={f.etc} onChange={(e) => setF({ ...f, etc: e.target.value })} /></Field>
      </div>
      {!standard && (
        <div className="mt-3">
          <p className="mb-1 text-subhead font-medium">Patterns <span className="font-normal text-label2">(regular expressions on the last 8 digits)</span></p>
          {patterns.map((p, i) => (
            <div key={i} className="mb-2 grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
              <Input aria-label="Pattern name" disabled={!manage} value={p.code} onChange={(e) => setPatterns(patterns.map((x, k) => (k === i ? { ...x, code: e.target.value } : x)))} />
              <Input aria-label="Regular expression" disabled={!manage} className="font-mono" value={p.regex} onChange={(e) => setPatterns(patterns.map((x, k) => (k === i ? { ...x, regex: e.target.value } : x)))} />
              {manage && <Button type="button" variant="plain" onClick={() => setPatterns(patterns.filter((_, k) => k !== i))}>Remove</Button>}
            </div>
          ))}
          {manage && <Button type="button" variant="secondary" onClick={() => setPatterns([...patterns, { code: '', regex: '' }])}>Add a pattern</Button>}
        </div>
      )}
      {manage && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Tier is on</label>
          <Button disabled={save.busy} onClick={() => save.run(() => patch(`/numbering/tiers/${rule.tier}`, standard ? { label: f.label, enabled: f.enabled } : { label: f.label, enabled: f.enabled, oneTimeFeeMinor: toMinor(f.fee || '0'), minMonthlyPlanMinor: toMinor(f.plan || '0'), minContractMonths: Number(f.months || 0), etcMultiplierBps: Math.round(Number(f.etc || 1) * 10000), patterns }), 'Saved')}>{save.busy ? 'Saving…' : 'Save'}</Button>
          <span className="text-footnote text-label2">Now: {money(rule.oneTimeFeeMinor)} fee · plan {money(rule.minMonthlyPlanMinor)}+ · {rule.minContractMonths} months · {rule.etcMultiplierBps / 10000}× ETC</span>
        </div>
      )}
      {save.error && <div className="mt-2"><Alert>{save.error}</Alert></div>}{save.ok && <div className="mt-2"><Alert tone="success">{save.ok}</Alert></div>}
    </Card>
  );
}

function RulesCard({ settings, onSaved }: { settings: any; onSaved: () => void }) {
  const { can } = useAuth();
  const [s, setS] = useState({ ...settings });
  const save = useAction(onSaved);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const edit = can('settings:manage');
  return (
    <Card>
      <label className="flex min-h-tap items-start gap-3"><input type="checkbox" disabled={!edit} className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={s.requireSim} onChange={(e) => setS({ ...s, requireSim: e.target.checked })} /><span><span className="font-medium">Every plan needs a SIM</span><span className="block text-footnote text-label2">The order cannot be placed (in the CRM) until a SIM card or an eSIM is chosen for each plan that needs one. Off: the step is offered but may be skipped.</span></span></label>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Hold a chosen number for (minutes)"><Input disabled={!edit} type="number" min={1} value={s.reservationMinutes} onChange={(e) => setS({ ...s, reservationMinutes: Number(e.target.value) })} /></Field>
        <Field label="Rest an identity (IMSI) for (days)"><Input disabled={!edit} type="number" min={0} value={s.imsiQuarantineDays} onChange={(e) => setS({ ...s, imsiQuarantineDays: Number(e.target.value) })} /></Field>
        <Field label="Auction winner has (hours)"><Input disabled={!edit} type="number" min={1} value={s.auctionSettlementHours} onChange={(e) => setS({ ...s, auctionSettlementHours: Number(e.target.value) })} /></Field>
      </div>
      <p className="mt-2 text-footnote text-label2">How long a number rests after a subscriber leaves is set with the other lifecycle rules (90 days by default).</p>
      {save.error && <div className="mt-2"><Alert>{save.error}</Alert></div>}{save.ok && !dirty && <div className="mt-2"><Alert tone="success">Saved</Alert></div>}
      {edit ? <div className="mt-3"><Button disabled={!dirty || save.busy} onClick={() => save.run(() => post('/settings/numbering', s), 'Saved')}>Save rules</Button></div> : <p className="mt-3 text-footnote text-label2">Only the super user changes these.</p>}
    </Card>
  );
}
