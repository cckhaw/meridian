'use client';
import { Alert, Badge, Button, Card, Field, Input, LargeTitle, SectionTitle, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { post, patch, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label, money } from '@/lib/format';
import { SignaturePad } from '../signature-pad';

const ID_TYPES = ['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE', 'RESIDENCE_PERMIT'];

export default function AssistedSale() {
  const { id } = useParams<{ id: string }>();
  const { data: v, error, loading, reload } = useApi(`/assisted/applications/${id}`);
  const { me, can } = useAuth();
  if (loading && !v) return <Spinner />;
  if (error || !v) return <Alert>{error ?? 'Not found'}</Alert>;
  const status = v.status as string;
  const verified = ['KYC_APPROVED', 'ORDERED'].includes(status);
  return (
    <>
      <LargeTitle subtitle="Work through the steps with the customer. Nothing is sold until the last step.">Assisted sale</LargeTitle>
      <p className="mb-4"><Link href="/assisted" className="text-subhead text-accent">← Assisted sales</Link></p>
      <Basket v={v} />
      {status === 'ORDERED' && <Done v={v} />}
      {status === 'CANCELLED' || status === 'EXPIRED' ? <Alert>This sale was {status.toLowerCase()}.</Alert> : null}
      {status === 'KYC_REJECTED' && <Alert>Identity check failed: {v.kyc?.reason}. The customer can be referred to online verification, or this sale cancelled.</Alert>}
      {status === 'KYC_REVIEW' && <Alert tone="info">Referred to compliance for review ({v.kyc?.needsReview ? 'waiting' : ''}). You can return to this sale when it is decided.</Alert>}
      {status === 'DRAFT' && (
        <>
          {v.kyc?.returned && <div className="mb-4"><Alert tone="info">Compliance asked for corrections: {v.kyc.reason}</Alert></div>}
          {v.customerKyc === 'VERIFIED'
            ? <Card className="mb-5"><SectionTitle>1. Existing customer</SectionTitle><p className="text-subhead text-label2">This customer is already identity-verified. Confirm they are the person in front of you.</p></Card>
            : <Details v={v} id={id} onDone={reload} />}
          {(v.personalProblems.length === 0 || v.customerKyc === 'VERIFIED') && <Attest v={v} id={id} onDone={reload} canAttest={can('kyc:attest')} />}
        </>
      )}
      {status === 'KYC_APPROVED' && <>
        {v.quote?.requiresShipping && <Address v={v} id={id} onDone={reload} />}
        <Authority v={v} id={id} staff={me?.displayName ?? ''} onDone={reload} />
        {v.consent?.authorisedAssistant && <Pay v={v} id={id} onDone={reload} canTakePayment={can('order:payment')} />}
      </>}
      {verified && null}
    </>
  );
}

function Basket({ v }: { v: any }) {
  if (!v.quote) return null;
  return (
    <Card className="mb-5 !p-4">
      <h2 className="mb-2 text-subhead font-semibold">Order</h2>
      <ul className="space-y-1 text-subhead">{v.quote.lines.map((l: any) => <li key={l.offerId} className="flex justify-between gap-3"><span>{l.name}{l.quantity > 1 ? ` × ${l.quantity}` : ''}</span><span className="tabular-nums text-label2">{l.monthlyMinor ? `${money(l.monthlyMinor)}/mo` : money(l.upfrontMinor)}</span></li>)}</ul>
      <p className="mt-2 border-t border-separator pt-2 text-subhead font-medium">Due today <span className="float-right tabular-nums">{money(v.quote.upfrontMinor)}</span></p>
    </Card>
  );
}

function Details({ v, id, onDone }: { v: any; id: string; onDone: () => void }) {
  const p = v.personal ?? {};
  const [f, setF] = useState({ fullName: p.fullName ?? '', dateOfBirth: p.dateOfBirth ?? '', idType: p.idType ?? 'NATIONAL_ID', idNumber: '', idExpiry: p.idExpiry ?? '', email: p.email ?? '', phone: p.phone ?? '', nationality: p.nationality ?? '' });
  const act = useAction(onDone);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const done = v.personalProblems.length === 0;
  return (
    <Card className="mb-5">
      <SectionTitle>1. Customer details {done && <Badge tone="success">Saved</Badge>}</SectionTitle>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void act.run(() => patch(`/assisted/applications/${id}`, { personal: { ...f, idExpiry: f.idExpiry || undefined, nationality: f.nationality || undefined } })); }}>
        <Field label="Full name (as on the ID)"><Input required value={f.fullName} onChange={set('fullName')} /></Field>
        <Field label="Date of birth"><Input type="date" required value={f.dateOfBirth} onChange={set('dateOfBirth')} /></Field>
        <Field label="ID type"><Select value={f.idType} onChange={set('idType')}>{ID_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
        <Field label="ID number" hint={p.idNumberMasked ? `On file: ${p.idNumberMasked}. Re-enter to confirm.` : undefined}><Input required autoComplete="off" value={f.idNumber} onChange={set('idNumber')} /></Field>
        <Field label="ID expiry"><Input type="date" required={f.idType === 'PASSPORT' || f.idType === 'RESIDENCE_PERMIT'} value={f.idExpiry} onChange={set('idExpiry')} /></Field>
        <Field label="Nationality (optional)"><Input value={f.nationality} onChange={set('nationality')} /></Field>
        <Field label="Email"><Input type="email" required value={f.email} onChange={set('email')} /></Field>
        <Field label="Mobile number"><Input type="tel" required value={f.phone} onChange={set('phone')} /></Field>
        {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
        <div className="sm:col-span-2"><Button type="submit" disabled={act.busy}>{act.busy ? 'Saving…' : done ? 'Update details' : 'Save details'}</Button></div>
      </form>
    </Card>
  );
}

function Attest({ v, id, onDone, canAttest }: { v: any; id: string; onDone: () => void; canAttest: boolean }) {
  const [seen, setSeen] = useState(false);
  const [face, setFace] = useState(false);
  const [notes, setNotes] = useState('');
  const act = useAction(onDone);
  return (
    <Card className="mb-5">
      <SectionTitle>{v.customerKyc === 'VERIFIED' ? '2. Confirm the customer' : '2. Check their ID in person'}</SectionTitle>
      <p className="mb-3 text-subhead text-label2">Look at the original document, not a copy or a photo on a phone. Compare it with what you entered above and with the customer in front of you.</p>
      <div className="space-y-1">
        <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={seen} onChange={(e) => setSeen(e.target.checked)} />I have seen the original ID document, it is valid and the details match.</label>
        <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={face} onChange={(e) => setFace(e.target.checked)} />The photo on the ID matches the customer.</label>
      </div>
      <div className="mt-3 max-w-md"><Field label="Notes (optional)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></Field></div>
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
      {!canAttest && <div className="mt-3"><Alert tone="info">Your role cannot attest IDs; ask a colleague, or send the customer to online verification.</Alert></div>}
      <div className="mt-4"><Button disabled={!seen || !face || act.busy || !canAttest} onClick={() => act.run(() => post(`/assisted/applications/${id}/kyc`, { idSighted: seen, faceMatches: face, notes: notes || undefined }))}>{act.busy ? 'Verifying…' : 'Confirm ID check'}</Button></div>
    </Card>
  );
}

function Address({ v, id, onDone }: { v: any; id: string; onDone: () => void }) {
  const a = v.address ?? {};
  const [f, setF] = useState({ line1: a.line1 ?? '', city: a.city ?? '', postcode: a.postcode ?? '', country: a.country ?? 'SG' });
  const act = useAction(onDone);
  return (
    <Card className="mb-5">
      <SectionTitle>Delivery address (optional)</SectionTitle>
      <p className="mb-3 text-subhead text-label2">Goods bought at the counter are handed over now. Fill this in only if something should be delivered instead.</p>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void act.run(() => patch(`/assisted/applications/${id}`, { address: f })); }}>
        <Field label="Address"><Input value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} /></Field>
        <Field label="City"><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        <Field label="Postcode"><Input value={f.postcode} onChange={(e) => setF({ ...f, postcode: e.target.value })} /></Field>
        <Field label="Country"><Input maxLength={2} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} /></Field>
        {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
        <div className="sm:col-span-2"><Button type="submit" variant="secondary" disabled={act.busy || !f.line1}>Save address</Button></div>
      </form>
    </Card>
  );
}

/** The customer's explicit authority for the assistant to complete the order for them, with their signature kept as evidence. */
function Authority({ v, id, staff, onDone }: { v: any; id: string; staff: string; onDone: () => void }) {
  const [sig, setSig] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const [auth, setAuth] = useState(false);
  const act = useAction(onDone);
  const done = !!v.consent?.authorisedAssistant;
  return (
    <Card className="mb-5">
      <SectionTitle>3. Customer’s authority {done && <Badge tone="success">Recorded</Badge>}</SectionTitle>
      {done ? <p className="text-subhead text-label2">The customer accepted the terms and authorised {v.consent.by ?? 'the assistant'} on {new Date(v.consent.at).toLocaleString()}.</p> : (
        <div className="space-y-3">
          <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={terms} onChange={(e) => setTerms(e.target.checked)} /><span className="text-subhead">The customer has been shown and accepts the terms and conditions (v{v.termsVersion}){v.termsUrl && <> — <a className="underline" href={v.termsUrl} target="_blank" rel="noreferrer">open</a></>}, and the privacy notice{v.privacyUrl && <> — <a className="underline" href={v.privacyUrl} target="_blank" rel="noreferrer">open</a></>}.</span></label>
          <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={auth} onChange={(e) => setAuth(e.target.checked)} /><span className="text-subhead">I, the customer, authorise <strong>{staff || 'the shop assistant'}</strong> to complete this order and register these services in my name.</span></label>
          <SignaturePad onChange={setSig} />
          {act.error && <Alert>{act.error}</Alert>}
          <Button disabled={!terms || !auth || !sig || act.busy} onClick={() => act.run(async () => {
            await post(`/assisted/applications/${id}/documents`, { kind: 'SIGNATURE', dataBase64: sig });
            await patch(`/assisted/applications/${id}`, { consent: { acceptedTerms: true, privacyAccepted: true, marketingOptIn: false, authorisedAssistant: true } });
          })}>{act.busy ? 'Saving…' : 'Record authority'}</Button>
        </div>
      )}
    </Card>
  );
}

function Pay({ v, id, onDone, canTakePayment }: { v: any; id: string; onDone: () => void; canTakePayment: boolean }) {
  const [method, setMethod] = useState('CASH');
  const [ref, setRef] = useState('');
  const [received, setReceived] = useState(false);
  const act = useAction(onDone);
  const due = v.quote?.upfrontMinor ?? 0;
  return (
    <Card className="mb-5">
      <SectionTitle>4. Payment and completion</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        {due > 0 && <>
          <Field label="Payment method"><Select value={method} onChange={(e) => setMethod(e.target.value)}><option value="CASH">Cash</option><option value="CREDIT_CARD">Card (terminal)</option><option value="QR">QR payment</option></Select></Field>
          <Field label="Receipt / approval number"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        </>}
      </div>
      {due > 0 && <label className="mt-3 flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={received} disabled={!canTakePayment} onChange={(e) => setReceived(e.target.checked)} />I have received {money(due)} from the customer.</label>}
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
      <div className="mt-4"><Button disabled={act.busy || (due > 0 && (!received || !ref.trim()))} onClick={() => act.run(() => post(`/assisted/applications/${id}/checkout`, due > 0 ? { payment: { method, reference: ref.trim(), confirmed: received } } : {}))}>{act.busy ? 'Completing…' : 'Complete sale'}</Button></div>
    </Card>
  );
}

function Done({ v }: { v: any }) {
  const o = v.order;
  return (
    <Card className="mb-5">
      <div className="space-y-2 text-center" role="status">
        <div aria-hidden className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success/15 text-title2 text-success">✓</div>
        <h2 className="text-title2 font-semibold">Sale complete</h2>
        <p className="text-subhead text-label2">Order {o?.id?.slice(0, 8).toUpperCase()} · {label(o?.state ?? '')}</p>
        {o?.numbers?.length > 0 && <p className="text-subhead">New number: <strong className="tabular-nums">{o.numbers.join(', ')}</strong></p>}
        <p className="flex justify-center gap-4 pt-2"><Link className="text-accent underline" href={`/orders/${o?.id}`}>View order</Link><Link className="text-accent underline" href="/assisted/new">Next customer</Link></p>
      </div>
    </Card>
  );
}
