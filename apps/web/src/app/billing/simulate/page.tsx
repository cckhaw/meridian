'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, LargeTitle, SectionTitle, Segmented, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, dt, label, money } from '@/lib/format';

export default function Page() { return <Suspense><Simulate /></Suspense>; }

type Tab = 'forecast' | 'ending' | 'plan' | 'saved';
const tileCls = 'rounded-control bg-surface2 p-3';
const Tile = ({ k, v, hint }: { k: string; v: string; hint?: string }) => <div className={tileCls}><p className="text-caption text-label2">{k}</p><p className="text-title3 font-semibold">{v}</p>{hint && <p className="text-caption text-label2">{hint}</p>}</div>;
const STREAM: Record<string, string> = { ETC: 'Early termination', SUBSCRIPTION: 'Plan', DEVICE_INSTALMENT: 'Device instalment', USAGE: 'Usage', THIRD_PARTY: 'Partner content', GOODS: 'Goods', ONE_TIME: 'One-time' };
const tomorrow = () => new Date().toISOString().slice(0, 10);

function Simulate() {
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || (params.get('service') ? 'ending' : 'forecast'));
  const service = params.get('service') ?? '';
  return (
    <>
      <LargeTitle subtitle="Try it before it happens: nothing here changes a customer's bill, account or service">Billing simulator</LargeTitle>
      <p className="mb-4 text-footnote text-label2"><Link className="text-accent" href="/billing">← Billing</Link></p>
      <div className="mb-5"><Segmented label="Simulator" value={tab} onChange={setTab} options={[{ value: 'forecast', label: 'Forecast bills' }, { value: 'ending', label: 'Ending a service' }, { value: 'plan', label: 'Plan change' }, { value: 'saved', label: 'Saved' }]} /></div>
      {tab === 'forecast' && <Forecast initial={service} />}
      {tab === 'ending' && <Ending initial={service} />}
      {tab === 'plan' && <PlanChange initial={service} />}
      {tab === 'saved' && <Saved />}
    </>
  );
}

function SaveBar({ onSave, saved, busy, defaultTitle }: { onSave: (title: string) => void; saved: any; busy: boolean; defaultTitle: string }) {
  const [title, setTitle] = useState(defaultTitle);
  if (saved) return <Alert tone="success">Saved on {dt(saved.createdAt)}. It is under Saved.</Alert>;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Keep this answer (for example the quote you gave)"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></Field>
      <Button variant="secondary" disabled={busy} onClick={() => onSave(title)}>Save</Button>
    </div>
  );
}

// ───────────────────────── forecast ─────────────────────────
function Forecast({ initial }: { initial: string }) {
  const [ref, setRef] = useState(initial);
  const [months, setMonths] = useState('24');
  const act = useAction();
  const [res, setRes] = useState<any>(null);
  const [saved, setSaved] = useState<any>(null);
  const run = async (save = false, title = '') => { const r = await act.run(() => post('/billing/simulate/projection', { ref: ref.trim(), months: Number(months), ...(save ? { save: true, title } : {}) })); if (r) { setRes(r); setSaved(r.saved ?? null); } };
  const max = res ? Math.max(...res.months.map((m: any) => m.totalMinor), 1) : 1;
  return (
    <div className="space-y-5">
      <Card>
        <p className="mb-3 text-subhead text-label2">What an account will be billed over the coming months, from today&apos;s prices, contracts and device instalments: the monthly plan, the device payments, the balance still owed on the device, and what it would cost to leave at each bill.</p>
        <div className="form-row">
          <Field label="Account id, or any number on the account"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="+6591234567" className="font-mono" /></Field>
          <Field label="Months ahead"><Select value={months} onChange={(e) => setMonths(e.target.value)}>{[3, 6, 12, 18, 24, 36, 48, 60].map((m) => <option key={m} value={m}>{m} months</option>)}</Select></Field>
          <Button disabled={act.busy || !ref.trim()} onClick={() => void run()}>{act.busy ? 'Working…' : 'Forecast'}</Button>
        </div>
        {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
      </Card>
      {res && (
        <>
          <Card>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Tile k={`Total over ${res.months.length} bills`} v={money(res.totals.totalMinor, res.account.currency)} hint={`${money(res.totals.netMinor, res.account.currency)} + tax ${money(res.totals.taxMinor, res.account.currency)}`} />
              <Tile k="Plans" v={money(res.totals.recurringMinor, res.account.currency)} hint="recurring charges" />
              <Tile k="Device instalments" v={money(res.totals.instalmentMinor, res.account.currency)} hint={res.equipmentBalanceNowMinor ? `${money(res.equipmentBalanceNowMinor, res.account.currency)} still owed today` : 'nothing owed on devices'} />
              <Tile k="Final instalment" v={res.finalInstalment ? `Bill ${res.finalInstalment.index} · ${d(res.finalInstalment.billDate)}` : '—'} hint={res.finalInstalment ? (res.finalInstalment.settled ? `Bill ${money(res.finalInstalment.billTotalMinor, res.account.currency)}; the device is paid off` : `${money(res.finalInstalment.balanceAfterMinor, res.account.currency)} still owed after it`) : 'no instalments running'} />
            </div>
            {res.contracts.length > 0 && <p className="mt-3 text-footnote text-label2">Contracts: {res.contracts.map((c: any) => `${c.identifier} ends ${d(c.endsOn)} (${c.termMonths} months)`).join(' · ')}</p>}
            {res.notes.map((n: string) => <p key={n} className="mt-1 text-footnote text-label2">{n}</p>)}
          </Card>
          <div>
            <SectionTitle>Bill by bill</SectionTitle>
            <div className="overflow-x-auto rounded-card bg-surface shadow-card">
              <table className="w-full min-w-[820px] text-left text-subhead" aria-label="Forecast bills">
                <thead><tr className="text-footnote text-label2"><th className="px-3 py-2">Bill</th><th className="px-3 py-2" /><th className="px-3 py-2 text-right">Plans</th><th className="px-3 py-2 text-right">Device</th><th className="px-3 py-2 text-right">Other</th><th className="px-3 py-2 text-right">Bill</th>{res.equipmentBalanceNowMinor > 0 && <th className="px-3 py-2 text-right">Device balance after</th>}{res.contracts.length > 0 && <th className="px-3 py-2 text-right">Cost to leave then</th>}</tr></thead>
                <tbody>
                  {res.months.map((m: any) => (
                    <tr key={m.index} className="border-t border-separator">
                      <td className="px-3 py-2"><span className="font-medium">{m.index}. {d(m.billDate)}</span><span className="block text-caption text-label2">{d(m.periodStart)} – {d(m.periodEnd)}</span></td>
                      <td className="px-3 py-2"><div className="h-2 w-24 overflow-hidden rounded-full bg-surface2"><div className="h-full bg-accent" style={{ width: `${Math.max(2, (m.totalMinor / max) * 100)}%` }} /></div></td>
                      <td className="px-3 py-2 text-right">{money(m.recurringMinor, res.account.currency)}</td>
                      <td className="px-3 py-2 text-right">{m.instalmentMinor ? money(m.instalmentMinor, res.account.currency) : '—'}</td>
                      <td className="px-3 py-2 text-right">{m.otherMinor ? money(m.otherMinor, res.account.currency) : '—'}</td>
                      <td className="px-3 py-2 text-right font-semibold">{money(m.totalMinor, res.account.currency)}</td>
                      {res.equipmentBalanceNowMinor > 0 && <td className="px-3 py-2 text-right">{money(m.equipmentBalanceMinor, res.account.currency)}</td>}
                      {res.contracts.length > 0 && <td className="px-3 py-2 text-right">{money(m.etcIfEndedMinor, res.account.currency)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <SaveBar onSave={(t) => void run(true, t)} saved={saved} busy={act.busy} defaultTitle={`Forecast ${res.months.length} months · ${res.account.name}`} />
        </>
      )}
    </div>
  );
}

// ───────────────────────── ending a service ─────────────────────────
function Ending({ initial }: { initial: string }) {
  const { can } = useAuth();
  const [ref, setRef] = useState(initial);
  const [date, setDate] = useState('');
  const [usage, setUsage] = useState('');
  const [deposit, setDeposit] = useState(false);
  const [adjust, setAdjust] = useState<'' | 'waive' | 'percent'>('');
  const [pct, setPct] = useState('50');
  const [reason, setReason] = useState('');
  const act = useAction();
  const [res, setRes] = useState<any>(null);
  const [saved, setSaved] = useState<any>(null);
  const body = (save: boolean, title: string) => ({ ref: ref.trim(), ...(date ? { date } : {}), ...(usage ? { unbilledUsageMinor: Math.round(Number(usage) * 100) } : {}), refundDeposit: deposit,
    ...(adjust ? { etcAdjust: { ...(adjust === 'waive' ? { waive: true } : { percent: Number(pct) }), reason } } : {}), ...(save ? { save: true, title } : {}) });
  const run = async (save = false, title = '') => { const r = await act.run(() => post('/billing/simulate/termination', body(save, title))); if (r) { setRes(r); setSaved(r.saved ?? null); } };
  return (
    <div className="space-y-5">
      <Card>
        <p className="mb-3 text-subhead text-label2">The exact amount a customer would owe if this service ended: the early-termination charge, the part of the month not yet billed, usage not yet billed, and tax. It is worked out by the same code that ends the service, so it is the figure that would be billed.</p>
        <div className="space-y-4">
          <div className="form-row">
            <Field label="Service id or number"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="+6591234567" className="font-mono" /></Field>
            <Field label="Ending on" hint="Empty: today."><Input type="date" min={tomorrow()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Usage not yet billed (amount)" hint="From the charging system, if known."><Input type="number" min={0} step="0.01" value={usage} onChange={(e) => setUsage(e.target.value)} /></Field>
          </div>
          <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={deposit} onChange={(e) => setDeposit(e.target.checked)} /><span><span className="block">Apply and refund the deposit</span><span className="text-footnote text-label2">Only when this is the account&apos;s last service.</span></span></label>
          {can('service:terminate') && (
            <div className="space-y-2 rounded-control border border-separator p-3">
              <Field label="Retention or goodwill"><Select value={adjust} onChange={(e) => setAdjust(e.target.value as '')}><option value="">Charge in full</option><option value="waive">Waive the early-termination charge</option><option value="percent">Charge only a percentage</option></Select></Field>
              {adjust === 'percent' && <Field label="Percent of the charge to collect"><Input type="number" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} /></Field>}
              {adjust && <Field label="Why (recorded with the quote)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>}
            </div>
          )}
          {act.error && <Alert>{act.error}</Alert>}
          <Button disabled={act.busy || !ref.trim() || (!!adjust && !reason.trim())} onClick={() => void run()}>{act.busy ? 'Working…' : 'Work out the amount'}</Button>
        </div>
      </Card>
      {res && (
        <>
          <Card>
            <p className="text-footnote text-label2">{res.service.identifier} · {res.service.offerId} · ending {d(res.date)}</p>
            <p className="mt-1 text-title1 font-semibold">{money(res.payNowMinor, res.currency)}</p>
            <p className="text-subhead text-label2">the customer would pay{res.depositAppliedMinor ? ` (after ${money(res.depositAppliedMinor, res.currency)} of their deposit)` : ''}{res.depositRefundedMinor ? `, and be refunded ${money(res.depositRefundedMinor, res.currency)} of the deposit` : ''}</p>
            <table className="mt-4 w-full text-subhead">
              <thead><tr className="text-left text-label2"><th>What</th><th className="text-right">Amount</th><th className="text-right">Tax</th></tr></thead>
              <tbody>
                {res.lines.map((l: any, k: number) => <tr key={k} className="border-t border-separator"><td className="py-1.5 pr-2">{l.description}<span className="block text-caption text-label2">{STREAM[l.stream] ?? label(l.stream)}</span></td><td className="text-right">{money(l.netMinor, res.currency)}</td><td className="text-right">{money(l.taxMinor, res.currency)}</td></tr>)}
                {res.lines.length === 0 && <tr><td className="py-3 text-label2" colSpan={3}>Nothing would be billed on ending.</td></tr>}
              </tbody>
              <tfoot><tr className="border-t-2 border-separator font-semibold"><td className="py-1.5">Closing invoice ({res.taxName})</td><td className="text-right">{money(res.netMinor, res.currency)}</td><td className="text-right">{money(res.taxMinor, res.currency)}</td></tr></tfoot>
            </table>
          </Card>
          <Card>
            <SectionTitle>The early-termination charge</SectionTitle>
            {res.service.contractTermMonths ? (
              <div className="space-y-1 text-subhead">
                <p>{res.service.contractTermMonths}-month contract from {d(res.service.contractStart)}: {res.etc.monthsElapsed} months elapsed, <strong>{res.etc.monthsRemaining}</strong> to run.</p>
                <p>Charge by the contract: <strong>{money(res.etc.quotedMinor, res.currency)}</strong>{res.etc.recurringMinor != null ? ` (remaining plan fees ${money(res.etc.recurringMinor, res.currency)} + device subsidy to claw back ${money(res.etc.clawbackMinor ?? 0, res.currency)})` : ''}{res.etc.vipMultiplierBps ? `, with the VIP number multiplier ${res.etc.vipMultiplierBps / 10000}×` : ''}.</p>
                {res.etc.adjustedBy && <p>Adjusted: <strong>{money(res.etc.chargeMinor, res.currency)}</strong> ({res.etc.adjustedBy}).</p>}
                {res.etc.waived && !res.etc.adjustedBy && <p>No charge: it falls in the free period at the end of the contract.</p>}
              </div>
            ) : <p className="text-subhead text-label2">No contract, so no early-termination charge.</p>}
            {res.notes.map((n: string) => <p key={n} className="mt-2 text-footnote text-label2">{n}</p>)}
          </Card>
          <SaveBar onSave={(t) => void run(true, t)} saved={saved} busy={act.busy} defaultTitle={`Quote to end ${res.service.identifier}`} />
        </>
      )}
    </div>
  );
}

// ───────────────────────── plan change ─────────────────────────
function PlanChange({ initial }: { initial: string }) {
  const { can } = useAuth();
  const offers = useApi<{ items: any[] }>(can('catalog:read') ? '/catalog?limit=100&status=ACTIVE' : null);
  const [ref, setRef] = useState(initial);
  const [offer, setOffer] = useState('');
  const [date, setDate] = useState('');
  const act = useAction();
  const [res, setRes] = useState<any>(null);
  const [saved, setSaved] = useState<any>(null);
  const run = async (save = false, title = '') => { const r = await act.run(() => post('/billing/simulate/plan-change', { ref: ref.trim(), newOfferId: offer.trim(), ...(date ? { effectiveDate: date } : {}), ...(save ? { save: true, title } : {}) })); if (r) { setRes(r); setSaved(r.saved ?? null); } };
  const diff = (n: number) => <span className={n < 0 ? 'text-success' : n > 0 ? 'text-danger' : ''}>{n > 0 ? '+' : ''}{money(n, res.currency)}</span>;
  return (
    <div className="space-y-5">
      <Card>
        <p className="mb-3 text-subhead text-label2">What changing a service&apos;s plan part-way through a billing period does to the next statement: the old plan up to the date, the new plan from it, compared with leaving things as they are.</p>
        <div className="form-row">
          <Field label="Service id or number"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="+6591234567" className="font-mono" /></Field>
          <Field label="New plan">{offers.data ? <Select value={offer} onChange={(e) => setOffer(e.target.value)}><option value="">Choose…</option>{offers.data.items.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select> : <Input value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="plan id" className="font-mono" />}</Field>
          <Field label="Change on" hint="Empty: today."><Input type="date" min={tomorrow()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
        <div className="mt-3"><Button disabled={act.busy || !ref.trim() || !offer.trim()} onClick={() => void run()}>{act.busy ? 'Working…' : 'Preview'}</Button></div>
      </Card>
      {res && (
        <>
          <Card>
            <p className="text-subhead">{res.from.name} ({money(res.from.monthlyMinor, res.currency)}/month) → <strong>{res.to.name}</strong> ({money(res.to.monthlyMinor, res.currency)}/month), from {d(res.effectiveDate)}</p>
            <p className="mb-3 text-footnote text-label2">Statement of {d(res.statementDate)} covers {d(res.periodStart)} – {d(res.periodEnd)}: {res.daysBefore} days on the old plan, {res.daysAfter} on the new.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Tile k="If nothing changes" v={money(res.ifNothingChanges.totalMinor, res.currency)} />
              <Tile k="With the change" v={money(res.withChange.totalMinor, res.currency)} hint={res.differenceMinor === 0 ? 'no difference' : `${res.differenceMinor > 0 ? '+' : ''}${money(res.differenceMinor, res.currency)} on this statement`} />
              <Tile k="The statement after" v={money(res.followingStatement.totalMinor, res.currency)} hint={`${res.followingDifferenceMinor > 0 ? '+' : ''}${money(res.followingDifferenceMinor, res.currency)} a month from then on`} />
            </div>
            <table className="mt-4 w-full text-subhead">
              <thead><tr className="text-left text-label2"><th>Line on the next statement</th><th className="text-right">Amount</th><th className="text-right">Tax</th></tr></thead>
              <tbody>{res.withChange.lines.map((l: any, k: number) => <tr key={k} className="border-t border-separator"><td className="py-1.5 pr-2">{l.description}</td><td className="text-right">{money(l.netMinor, res.currency)}</td><td className="text-right">{money(l.taxMinor, res.currency)}</td></tr>)}</tbody>
              <tfoot><tr className="border-t-2 border-separator font-semibold"><td className="py-1.5">Difference from doing nothing</td><td colSpan={2} className="text-right">{diff(res.differenceMinor)}</td></tr></tfoot>
            </table>
            {res.notes.map((n: string) => <p key={n} className="mt-2 text-footnote text-label2">{n}</p>)}
          </Card>
          <SaveBar onSave={(t) => void run(true, t)} saved={saved} busy={act.busy} defaultTitle={`Plan change ${res.service.identifier} to ${res.to.name}`} />
        </>
      )}
    </div>
  );
}

// ───────────────────────── saved ─────────────────────────
function Saved() {
  const list = useApi<{ items: any[] }>('/billing/simulations?limit=50');
  const [open, setOpen] = useState<any>(null);
  const act = useAction(async () => { await list.reload(); setOpen(null); });
  const KIND: Record<string, string> = { PROJECTION: 'Forecast', TERMINATION: 'Ending a service', PLAN_CHANGE: 'Plan change' };
  const show = async (id: string) => setOpen(await api(`/billing/simulations/${id}`));
  return (
    <div className="space-y-5">
      {list.loading && !list.data && <Spinner />}
      {list.data && list.data.items.length === 0 && <Empty>Nothing saved yet. Save an answer after a simulation to keep it, for example a quote you gave a customer.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <DataList label="Saved simulations" rows={list.data.items} rowKey={(r: any) => r.id}
          columns={[
            { key: 't', label: 'Saved', primary: true, render: (r: any) => <><span className="font-medium">{r.title || KIND[r.kind]}</span><span className="block text-caption text-label2">{r.createdBy} · {dt(r.createdAt)}</span></> },
            { key: 'k', label: 'Kind', render: (r: any) => <Badge>{KIND[r.kind]}</Badge> },
            { key: 'f', label: 'Figure', right: true, render: (r: any) => (r.kind === 'PROJECTION' ? money(r.summary.totals.totalMinor) : r.kind === 'TERMINATION' ? `${money(r.summary.payNowMinor)} to pay` : `${r.summary.differenceMinor > 0 ? '+' : ''}${money(r.summary.differenceMinor)}`) },
          ]}
          actions={(r: any) => (<><Button variant="secondary" onClick={() => void show(r.id)}>Open</Button><Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post(`/billing/simulations/${r.id}/delete`))}>Delete</Button></>)} />
      )}
      {open && (
        <Card>
          <SectionTitle>{open.title || KIND[open.kind]}</SectionTitle>
          <p className="mb-2 text-footnote text-label2">{KIND[open.kind]} · saved by {open.createdBy} on {dt(open.createdAt)}</p>
          <table className="w-full text-subhead"><thead><tr className="text-left text-label2"><th>#</th><th>Date</th><th className="text-right">Net</th><th className="text-right">Tax</th><th className="text-right">Total</th></tr></thead>
            <tbody>{open.rows.map((r: any) => <tr key={r.seq} className="border-t border-separator"><td className="py-1">{r.seq}</td><td>{d(r.billDate)}</td><td className="text-right">{money(r.netMinor)}</td><td className="text-right">{money(r.taxMinor)}</td><td className="text-right font-semibold">{money(r.totalMinor)}</td></tr>)}</tbody></table>
        </Card>
      )}
      {act.error && <Alert>{act.error}</Alert>}
    </div>
  );
}
