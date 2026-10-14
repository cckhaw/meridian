'use client';
import { Alert, Button, Card, Field, Input, SectionTitle, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';

interface Form { requireSim: boolean; reservationMinutes: number; imsiQuarantineDays: number; auctionSettlementHours: number; portInExpiryDays: number; msisdnCoolingDays: number }

/** The rules behind an MSISDN's, ICCID's and IMSI's life: how long things are held, and how long they rest before they can be used again. */
export function NumberingSettings() {
  const n = useApi<any>('/settings/numbering');
  const l = useApi<any>('/settings/lifecycle');
  if (n.error || l.error) return <Alert>{n.error ?? l.error}</Alert>;
  if (!n.data || !l.data) return <Spinner />;
  return <Editor key={JSON.stringify([n.data, l.data.termination.quarantineDays])} numbering={n.data} lifecycle={l.data} onSaved={() => { void n.reload(); void l.reload(); }} />;
}

function Editor({ numbering, lifecycle, onSaved }: { numbering: any; lifecycle: any; onSaved: () => void }) {
  const initial: Form = { ...numbering, msisdnCoolingDays: lifecycle.termination.quarantineDays };
  const [s, setS] = useState<Form>(initial);
  const save = useAction(onSaved);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);
  const num = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });
  const submit = () => save.run(async () => {
    const { msisdnCoolingDays, ...rest } = s;
    await post('/settings/numbering', rest);
    if (msisdnCoolingDays !== initial.msisdnCoolingDays) await post('/settings/lifecycle', { ...lifecycle, termination: { ...lifecycle.termination, quarantineDays: msisdnCoolingDays } });
  }, 'Saved');
  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Cooling-off periods</SectionTitle>
        <p className="-mt-2 mb-3 text-subhead text-label2">When a subscriber leaves, their MSISDN and IMSI are not reused straight away. They rest for the period below, then the daily lifecycle job returns them to stock.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="MSISDN rests for (days)" hint="After termination or port-out. 0 = available the next job run. Ported-out numbers stay out until the port is closed."><Input type="number" min={0} max={730} value={s.msisdnCoolingDays} onChange={num('msisdnCoolingDays')} /></Field>
          <Field label="IMSI rests for (days)" hint="The IMSI is detached from the SIM at termination, rests, then returns to the pool to be bound to a new SIM batch or eSIM profile."><Input type="number" min={0} max={730} value={s.imsiQuarantineDays} onChange={num('imsiQuarantineDays')} /></Field>
        </div>
      </Card>
      <Card>
        <SectionTitle>Holds and auctions</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Hold a chosen MSISDN or ICCID for (minutes)" hint="While a seller is checking out. MSISDNs on a placed order stay held until it activates or is cancelled."><Input type="number" min={1} max={1440} value={s.reservationMinutes} onChange={num('reservationMinutes')} /></Field>
          <Field label="A port-in waits for the donor operator (days)" hint="If the other operator has not answered by then, the request expires. The customer keeps a temporary number if they were given one."><Input type="number" min={1} max={60} value={s.portInExpiryDays} onChange={num('portInExpiryDays')} /></Field>
          <Field label="Auction winner has (hours)" hint="To complete the order for a number won at auction."><Input type="number" min={1} max={720} value={s.auctionSettlementHours} onChange={num('auctionSettlementHours')} /></Field>
        </div>
        <label className="mt-4 flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={s.requireSim} onChange={(e) => setS({ ...s, requireSim: e.target.checked })} /><span><span className="font-medium">Every plan needs a SIM</span><span className="block text-footnote text-label2">The CRM cannot place an order for a plan with SIM activation until an ICCID (SIM card or eSIM) is chosen. Off: the step is offered but may be skipped.</span></span></label>
      </Card>
      <Card>
        <SectionTitle>How an MSISDN, ICCID and IMSI move</SectionTitle>
        <dl className="space-y-3 text-subhead">
          <div><dt className="font-medium">ICCID · SIM card</dt><dd className="text-label2">In warehouse → with a dealer → reserved for an order → active → damaged or scrapped → decommissioned. A physical card is retired for good when its customer leaves; an eSIM ICCID is a reusable template and goes back to the warehouse.</dd></div>
          <div><dt className="font-medium">IMSI · subscriber identity</dt><dd className="text-label2">In the pool → bound to a SIM → active → resting ({s.imsiQuarantineDays} days) → recycled → back in the pool.</dd></div>
          <div><dt className="font-medium">MSISDN · phone number</dt><dd className="text-label2">Available → held at checkout ({s.reservationMinutes} min) → in service → resting ({s.msisdnCoolingDays} days) → available again, sorted into its tier again. Special numbers can be blocked or held for auction.</dd></div>
        </dl>
        <p className="mt-3 text-footnote text-label2">VIP tier patterns, fees and contract minimums are on the Numbers &amp; SIMs page, under VIP tiers.</p>
      </Card>
      {save.error && <Alert>{save.error}</Alert>}{save.ok && !dirty && <Alert tone="success">Saved</Alert>}
      <Button disabled={!dirty || save.busy} onClick={submit}>{save.busy ? 'Saving…' : 'Save'}</Button>
    </div>
  );
}
