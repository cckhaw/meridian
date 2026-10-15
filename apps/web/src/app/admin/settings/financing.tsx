'use client';
import { Alert, Badge, Button, Card, Field, Input, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { money, step as moneyStep, toInput, toMinor } from '@/lib/format';

interface Band { label: string; minScore: number; maxScore: number; upfrontBps: number }
interface Settings { financeOverContract: boolean; creditCheckRequired: boolean; providerReturns: 'SCORE' | 'UPFRONT_AMOUNT'; bands: Band[]; onProviderFailure: 'FALLBACK_SHARE' | 'BLOCK'; fallbackUpfrontBps: number; validityDays: number; minUpfrontMinor: number }
interface View { settings: Settings; bureauConfigured: boolean; defaults: Settings }
interface Test { ok: boolean; error?: string; score?: number | null; band?: string | null; providerUpfrontMinor?: number | null; ratioBps?: number; upfrontMinor?: number; source?: string }
const pct = (bps: number) => bps / 100;

/** Settings → Device financing: a device on a contract is paid over the contract, and a credit check decides how much is paid first. */
export function FinancingSettings() {
  const view = useApi<View>('/settings/financing');
  const act = useAction(async () => { await view.reload(); });
  const [draft, setDraft] = useState<Settings | null>(null);
  if (view.error) return <Alert>{view.error}</Alert>;
  if (!view.data) return <Spinner />;
  const s = draft ?? view.data.settings;
  const upd = (p: Partial<Settings>) => setDraft({ ...s, ...p });
  const updBand = (i: number, p: Partial<Band>) => upd({ bands: s.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) });
  const save = async () => { if (await act.run(() => post('/settings/financing', s), 'Saved')) setDraft(null); };
  return (
    <div className="space-y-6">
      <Card>
        <p className="text-subhead text-label2">A device bought on a contract is <strong className="text-label">paid for over the whole contract</strong>: the price after the subsidy is split evenly across the months and billed with the monthly plan fee. The customer can still choose to pay in full. A <strong className="text-label">credit check</strong> on the customer’s ID number decides whether a part is paid upfront: a weaker credit profile pays more first, and the rest is split evenly. The ID number is sent only with the customer’s consent and only a hash of it is kept.</p>
      </Card>
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <section aria-label="Financing" className="space-y-3">
        <SectionTitle>Financing</SectionTitle>
        <Card className="space-y-3">
          <label className="flex items-start gap-2 text-subhead"><input type="checkbox" className="mt-1" checked={s.financeOverContract} onChange={(e) => upd({ financeOverContract: e.target.checked })} /> <span><strong>Finance a device over its contract</strong><span className="block text-footnote text-label2">When off, a device on a contract is paid in full at the till unless someone chooses instalments on the line.</span></span></label>
          <label className="flex items-start gap-2 text-subhead"><input type="checkbox" className="mt-1" checked={s.creditCheckRequired} onChange={(e) => upd({ creditCheckRequired: e.target.checked })} /> <span><strong>Check the customer’s credit profile first</strong><span className="block text-footnote text-label2">The order cannot be placed with a financed device until the check is done.{!view.data.bureauConfigured && ' No credit bureau is set up yet: the fallback share below applies. Set one up under Integration hub → Finance.'}</span></span></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="The bureau returns" hint="A score that the bands below turn into an upfront share, or the upfront amount itself."><Select value={s.providerReturns} onChange={(e) => upd({ providerReturns: e.target.value as Settings['providerReturns'] })}><option value="SCORE">A credit score</option><option value="UPFRONT_AMOUNT">The upfront amount</option></Select></Field>
            <Field label="If the bureau cannot be reached"><Select value={s.onProviderFailure} onChange={(e) => upd({ onProviderFailure: e.target.value as Settings['onProviderFailure'] })}><option value="FALLBACK_SHARE">Apply the fallback share</option><option value="BLOCK">Stop the sale</option></Select></Field>
            <Field label="Fallback upfront share (%)"><Input type="number" min={0} max={100} step={1} value={pct(s.fallbackUpfrontBps)} onChange={(e) => upd({ fallbackUpfrontBps: Math.round(Number(e.target.value) * 100) })} /></Field>
            <Field label="A check stays valid (days)"><Input type="number" min={1} max={365} value={s.validityDays} onChange={(e) => upd({ validityDays: Number(e.target.value) })} /></Field>
            <Field label="Least upfront payment" hint="When a check asks for something upfront, never less than this."><Input type="number" min={0} step={moneyStep()} value={toInput(s.minUpfrontMinor)} onChange={(e) => upd({ minUpfrontMinor: toMinor(e.target.value) })} /></Field>
          </div>
        </Card>
      </section>
      {s.providerReturns === 'SCORE' && (
        <section aria-label="Score bands" className="space-y-3">
          <SectionTitle action={<Button variant="secondary" onClick={() => upd({ bands: [...s.bands, { label: 'New band', minScore: 0, maxScore: 0, upfrontBps: 0 }] })}>＋ Add a band</Button>}>Score bands</SectionTitle>
          <Card className="space-y-2">
            <p className="text-footnote text-label2">Scores run from 0 to 1000. The share is of the amount financed (the price after the subsidy). Bands must not overlap.</p>
            {s.bands.map((b, i) => (
              <div key={i} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_6rem_6rem_7rem_auto]">
                <Field label="Name"><Input value={b.label} maxLength={30} onChange={(e) => updBand(i, { label: e.target.value })} /></Field>
                <Field label="From"><Input type="number" min={0} max={1000} value={b.minScore} onChange={(e) => updBand(i, { minScore: Number(e.target.value) })} /></Field>
                <Field label="To"><Input type="number" min={0} max={1000} value={b.maxScore} onChange={(e) => updBand(i, { maxScore: Number(e.target.value) })} /></Field>
                <Field label="Upfront (%)"><Input type="number" min={0} max={100} value={pct(b.upfrontBps)} onChange={(e) => updBand(i, { upfrontBps: Math.round(Number(e.target.value) * 100) })} /></Field>
                <Button variant="secondary" disabled={s.bands.length <= 1} onClick={() => upd({ bands: s.bands.filter((_, j) => j !== i) })} aria-label={`Remove ${b.label}`}>Remove</Button>
              </div>))}
          </Card>
        </section>)}
      <div className="flex gap-2">
        <Button disabled={act.busy || !draft} onClick={() => void save()}>Save</Button>
        {draft && <Button variant="secondary" onClick={() => setDraft(null)}>Discard changes</Button>}
        <Button variant="secondary" onClick={() => setDraft({ ...view.data!.defaults })}>Reset to the standard set</Button>
      </div>
      <TryBureau s={view.data.settings} configured={view.data.bureauConfigured} />
    </div>
  );
}

function TryBureau({ s, configured }: { s: Settings; configured: boolean }) {
  const [id, setId] = useState('');
  const [amount, setAmount] = useState(toInput(100000));
  const [res, setRes] = useState<Test | null>(null);
  const act = useAction();
  return (
    <section aria-label="Try the bureau" className="space-y-3">
      <SectionTitle>Try the credit bureau</SectionTitle>
      <Card className="space-y-3">
        <p className="text-footnote text-label2">{configured ? 'Sends the ID number to the bureau connection exactly as a real check would (with a made-up amount) and shows how the saved settings read the answer. Nothing is kept against a customer. With the built-in simulator, the score follows the last digit of the ID: 0 gives 350 and 9 gives 890.' : 'No credit bureau is set up. Add one under Integration hub → Finance → Credit bureau (a REST address, or the built-in simulator for trying the flow).'}</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
          <Field label="ID number"><Input value={id} maxLength={40} onChange={(e) => setId(e.target.value)} /></Field>
          <Field label="Amount financed"><Input type="number" min={1} step={moneyStep()} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Button disabled={act.busy || id.trim().length < 3 || !configured} onClick={() => void act.run(async () => { setRes(await post('/settings/financing/test', { idNumber: id, financedMinor: toMinor(amount) })); })}>Try it</Button>
        </div>
        {act.error && <Alert>{act.error}</Alert>}
        {res && (res.ok
          ? <div className="rounded-control bg-surface2 p-3 text-subhead"><p>{res.source === 'SIMULATOR' && <Badge>Simulator</Badge>} {res.score !== null && res.score !== undefined && <>Score <strong>{res.score}</strong>{res.band ? ` (${res.band})` : ''}. </>}{res.providerUpfrontMinor !== null && res.providerUpfrontMinor !== undefined && <>The bureau asks <strong>{money(res.providerUpfrontMinor)}</strong> upfront. </>}</p>
              <p className="mt-1">Upfront <strong>{pct(res.ratioBps ?? 0)}%</strong> = {money(res.upfrontMinor ?? 0)}; the other {money(toMinor(amount) - (res.upfrontMinor ?? 0))} is split evenly across the contract.{s.providerReturns === 'SCORE' && res.score !== null && res.band === null ? ' No band covers this score: the fallback share applies.' : ''}</p></div>
          : <Alert>{res.error}</Alert>)}
      </Card>
    </section>
  );
}
