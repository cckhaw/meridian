'use client';
import { AgreementSigner, Alert, Badge, Button, Card, FiberCoverageCheck, Field, IdCamera, Input, Select, Spinner, type AgreementView, type CapturedPhoto, type FiberApi, type SignedPayload } from '@meridian/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfig } from '@/components/config';
import { api, ApiError } from '@/lib/api';
import { PaymentStep, type PaymentStart } from './payment';

interface View {
  id: string; status: string; expiresAt: string;
  quote: { lines: Array<{ offerId: string; name: string; quantity: number; upfrontMinor: number; monthlyMinor: number; deal?: { planName: string; termMonths: number; instalmentMinor?: number } }>; financing?: { months: number; upfrontMinor: number; instalmentMinor: number; estimate: boolean; creditCheck: boolean }; upfrontMinor: number; monthlyMinor: number; requiresShipping: boolean; requiresInstallation?: boolean; taxName: string } | null;
  fiber?: { reservationId: string } | null;
  personal: Record<string, string | undefined>; personalProblems: string[]; address: Record<string, string> | null; consent: Record<string, unknown> | null;
  kyc: { status: string; method: string; reason: string | null; returned: boolean; needsReview?: boolean; canOrderWhileWaiting?: boolean } | null; documents: string[];
  order: { id: string; number?: string | null; state: string; totalMinor: number; trackingNumber: string | null; failureReason: string | null; numbers: string[]; kycHold?: boolean; lines: Array<{ name: string; quantity: number }> } | null;
}

const ID_LABEL: Record<string, string> = { NATIONAL_ID: 'National ID card', PASSPORT: 'Passport', DRIVING_LICENCE: 'Driving licence', RESIDENCE_PERMIT: 'Residence permit' };
type Step = 'details' | 'documents' | 'address' | 'review';

export function Wizard() {
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentStart | null>(null);
  const [step, setStep] = useState<Step | null>(null);

  const refresh = useCallback(async () => {
    try { const v = await api<View>('/application'); setView(v); setError(null); return v; }
    catch (e) { if (e instanceof ApiError && e.status === 404) setMissing(true); else setError((e as Error).message); return null; }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Wait for the reviewer / the payment provider: poll while something outside the shopper's control is pending.
  const waiting = view?.status === 'KYC_REVIEW';
  const paying = view?.status === 'ORDERED' && view.order?.state === 'PAYMENT_PENDING';
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [waiting, refresh]);

  const startPayment = useCallback(async () => {
    try { setPayment((await api<{ payment: PaymentStart }>('/application/payment', { method: 'POST', json: {} })).payment); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, []);
  // An order waiting for money needs a payment form, also after a page reload.
  useEffect(() => { if (paying && !payment) void startPayment(); }, [paying, payment, startPayment]);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!settling) return;
    const t = setInterval(async () => { const v = await refresh(); if (v && v.order && v.order.state !== 'PAYMENT_PENDING') setSettling(false); }, 2500);
    return () => clearInterval(t);
  }, [settling, refresh]);

  const next = useMemo<Step>(() => {
    if (!view) return 'details';
    if (view.personalProblems.length) return 'details';
    const need = ['ID_FRONT', 'SELFIE', ...(view.personal.idType === 'PASSPORT' ? [] : ['ID_BACK'])];
    if (need.some((k) => !view.documents.includes(k))) return 'documents';
    if ((view.quote?.requiresShipping || view.quote?.requiresInstallation) && !view.address) return 'address';
    return 'review';
  }, [view]);
  // Stay on the documents step while photos are added, instead of jumping ahead the moment the last one lands.
  useEffect(() => { if (step === null && next === 'documents') setStep('documents'); }, [step, next]);
  const current: Step = step ?? next;

  if (missing) return <Card><p className="mb-4">You don’t have a sign-up in progress.</p><Link href="/" className="inline-flex min-h-tap items-center rounded-control bg-accent px-5 font-medium text-accent-fg">Choose a plan</Link></Card>;
  if (!view) return error ? <Alert>{error}</Alert> : <Spinner />;

  const header = <Summary view={view} />;

  // ── outcomes outside the form ──
  // A clean check does not hold the shopper up: they go on to pay while a person reviews it, and the service is switched on when it is approved.
  const notYet = view.status === 'KYC_REVIEW' && !view.kyc?.canOrderWhileWaiting;
  if (notYet) return <Outcome title="We’re checking your ID" body="A team member is reviewing your photos. This page updates by itself; you can also come back later with the same browser." busy>{header}</Outcome>;
  if (view.status === 'KYC_REJECTED') return (
    <Outcome title="We couldn’t verify your identity" body={view.kyc?.reason ?? 'The details or documents did not pass our checks.'} tone="danger">
      <Button onClick={async () => { await api('/application', { method: 'DELETE' }); router.push('/'); }}>Start again</Button>
    </Outcome>
  );
  if (view.status === 'CANCELLED' || view.status === 'EXPIRED') return (
    <Outcome title={view.status === 'EXPIRED' ? 'This sign-up expired' : 'This sign-up was cancelled'} body="Nothing was charged. You can start again any time.">
      <Button onClick={async () => { await api('/application', { method: 'DELETE' }); router.push('/'); }}>Choose a plan</Button>
    </Outcome>
  );
  if (view.status === 'ORDERED' && view.order) {
    const o = view.order;
    if (o.state === 'PAYMENT_PENDING') {
      return (
        <div className="mx-auto max-w-xl space-y-5">
          <Stepper at={4} />
          {header}
          {settling ? <Outcome title="Confirming your payment" body="This only takes a moment." busy /> : payment ? <PaymentStep payment={payment} onSubmitted={() => setSettling(true)} onRetry={startPayment} /> : error ? <Alert>{error}</Alert> : <Spinner />}
          {error && payment && <Alert>{error}</Alert>}
          <Button variant="plain" onClick={async () => { await api('/application', { method: 'DELETE' }); router.push('/'); }}>Cancel this order</Button>
        </div>
      );
    }
    if (o.state === 'FAILED' || o.state === 'CANCELLED') return <Outcome title="We couldn’t complete your order" body={o.failureReason ?? 'Something went wrong. You have not been charged, or any charge will be refunded.'} tone="danger"><Link href="/" className="font-medium text-accent underline">Back to plans</Link></Outcome>;
    return <Done order={o} shipping={view.address} />;
  }

  // ── the form ──
  const approved = view.status === 'KYC_APPROVED' || (view.status === 'KYC_REVIEW' && !!view.kyc?.canOrderWhileWaiting);
  const inReview = view.status === 'KYC_REVIEW';
  const stepNo = approved ? 4 : ({ details: 1, documents: 2, address: 3, review: 3 } as const)[current];
  return (
    <div className="mx-auto max-w-xl space-y-5">
      <Stepper at={stepNo} />
      {view.kyc?.returned && <Alert tone="info">Please update your details: {view.kyc.reason}</Alert>}
      {header}
      {error && <Alert>{error}</Alert>}
      {approved
        ? <Approved inReview={inReview} onError={setError} onPayment={(p) => { setPayment(p); void refresh(); }} />
        : current === 'details' ? <Details view={view} onDone={async () => { setStep(null); await refresh(); }} />
        : current === 'documents' ? <Documents view={view} onChange={refresh} onBack={() => setStep('details')} onDone={() => setStep(null)} />
        : current === 'address' ? <AddressForm view={view} onDone={async () => { setStep(null); await refresh(); }} />
        : <Review view={view} onBack={() => setStep(view.quote?.requiresShipping || view.quote?.requiresInstallation ? 'address' : 'documents')} onSubmitted={async () => { setStep(null); await refresh(); }} />}
    </div>
  );
}

function Stepper({ at }: { at: number }) {
  const steps = ['Your details', 'ID check', 'Review', 'Pay'];
  return (
    <ol aria-label="Progress" className="flex gap-2 text-caption">
      {steps.map((s, i) => (
        <li key={s} aria-current={i + 1 === at ? 'step' : undefined} className={`flex-1 rounded-full px-2 py-1 text-center font-medium ${i + 1 === at ? 'bg-accent text-accent-fg' : i + 1 < at ? 'bg-accent/20 text-accent' : 'bg-surface2 text-label2'}`}>{i + 1}. {s}</li>
      ))}
    </ol>
  );
}

function Summary({ view }: { view: View }) {
  const { money } = useConfig();
  if (!view.quote) return null;
  const q = view.quote;
  return (
    <Card className="!p-4">
      <h2 className="mb-2 text-subhead font-semibold">Your order</h2>
      <ul className="space-y-1 text-subhead">
        {q.lines.map((l) => <li key={l.offerId} className="flex justify-between gap-3"><span>{l.name}{l.quantity > 1 ? ` × ${l.quantity}` : ''}{l.deal && <span className="block text-footnote text-label2">On a {l.deal.termMonths}-month contract with {l.deal.planName}{l.deal.instalmentMinor ? `, paid ${money(l.deal.instalmentMinor)} a month with your plan` : ''}</span>}</span><span className="tabular-nums text-label2">{l.monthlyMinor ? `${money(l.monthlyMinor)}/mo` : money(l.upfrontMinor)}</span></li>)}
      </ul>
      <p className="mt-2 border-t border-separator pt-2 text-subhead font-medium">Due today{q.financing?.estimate ? ' (estimate)' : ''} <span className="float-right tabular-nums">{money(q.upfrontMinor)}</span></p>
      {q.financing?.estimate && <p className="text-footnote text-label2">A quick credit check on your ID decides how much of the device is paid today. The rest is split evenly over {q.financing.months} months.</p>}
      {q.monthlyMinor > 0 && <p className="text-footnote text-label2">then {money(q.monthlyMinor)} every month · prices include {q.taxName}</p>}
    </Card>
  );
}

function Outcome({ title, body, busy, tone, children }: { title: string; body?: string; busy?: boolean; tone?: 'danger'; children?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl space-y-4 text-center" role="status" aria-live="polite">
      {busy && <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" aria-hidden />}
      <h1 className={`text-title1 font-bold ${tone === 'danger' ? 'text-danger' : ''}`}>{title}</h1>
      {body && <p className="text-body text-label2">{body}</p>}
      <div className="space-y-4 text-left">{children}</div>
    </div>
  );
}

function useSave(onDone: () => void | Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); await onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return { busy, error, run };
}

function Details({ view, onDone }: { view: View; onDone: () => void | Promise<void> }) {
  const { kyc } = useConfig();
  const p = view.personal;
  const [f, setF] = useState({ fullName: p.fullName ?? '', dateOfBirth: p.dateOfBirth ?? '', nationality: p.nationality ?? '', idType: p.idType ?? 'NATIONAL_ID', idNumber: '', idExpiry: p.idExpiry ?? '', email: p.email ?? '', phone: p.phone ?? '' });
  const { busy, error, run } = useSave(onDone);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(() => api('/application', { method: 'PATCH', json: { personal: { ...f, nationality: f.nationality || undefined, idExpiry: f.idExpiry || undefined } } })); }}>
        <h2 className="text-title3 font-semibold">Tell us about you</h2>
        <p className="text-subhead text-label2">Exactly as it appears on your ID. You must be at least {kyc.minAge}.</p>
        <Field label="Full name"><Input autoComplete="name" required value={f.fullName} onChange={set('fullName')} /></Field>
        <Field label="Date of birth"><Input type="date" autoComplete="bday" required max={today} value={f.dateOfBirth} onChange={set('dateOfBirth')} /></Field>
        <Field label="Email" hint="We’ll send your order confirmation here."><Input type="email" autoComplete="email" required value={f.email} onChange={set('email')} /></Field>
        <Field label="Mobile number" hint="A number we can reach you on, with country code."><Input type="tel" autoComplete="tel" required value={f.phone} onChange={set('phone')} /></Field>
        <Field label="ID type"><Select value={f.idType} onChange={set('idType')}>{kyc.idTypes.map((t) => <option key={t} value={t}>{ID_LABEL[t] ?? t}</option>)}</Select></Field>
        <Field label="ID number" hint={p.idNumberMasked ? `On file: ${p.idNumberMasked}. Enter it again to confirm.` : undefined}><Input required autoComplete="off" value={f.idNumber} onChange={set('idNumber')} /></Field>
        <Field label={f.idType === 'PASSPORT' || f.idType === 'RESIDENCE_PERMIT' ? 'ID expiry date' : 'ID expiry date (if shown)'}><Input type="date" min={today} required={f.idType === 'PASSPORT' || f.idType === 'RESIDENCE_PERMIT'} value={f.idExpiry} onChange={set('idExpiry')} /></Field>
        <Field label="Nationality (optional)"><Input autoComplete="country-name" value={f.nationality} onChange={set('nationality')} /></Field>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={busy} className="w-full">{busy ? 'Saving…' : 'Continue'}</Button>
      </form>
    </Card>
  );
}

function Documents({ view, onChange, onBack, onDone }: { view: View; onChange: () => Promise<unknown>; onBack: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shots, setShots] = useState<Record<string, CapturedPhoto>>({});
  // The ID photos are taken live with the camera: there is no way to pick a picture from the gallery or to upload a file.
  const need: Array<{ kind: string; label: string; hint: string; facing: 'environment' | 'user'; frame: 'card' | 'face' | 'page' }> = view.personal.idType === 'PASSPORT'
    ? [{ kind: 'ID_FRONT', label: 'Your passport photo page', hint: 'The page with your photo and number.', facing: 'environment', frame: 'page' }, { kind: 'SELFIE', label: 'A selfie', hint: 'Your face clearly visible, in good light.', facing: 'user', frame: 'face' }]
    : [{ kind: 'ID_FRONT', label: `Front of your ${ID_LABEL[view.personal.idType ?? ''] ?? 'ID'}`, hint: 'The side with your photo.', facing: 'environment', frame: 'card' }, { kind: 'ID_BACK', label: 'Back of your ID', hint: 'The other side.', facing: 'environment', frame: 'card' }, { kind: 'SELFIE', label: 'A selfie', hint: 'Your face clearly visible, in good light.', facing: 'user', frame: 'face' }];
  const upload = async (kind: string, p: CapturedPhoto | null) => {
    if (!p) return;
    setShots((s) => ({ ...s, [kind]: p }));
    setBusy(kind); setError(null);
    try { await api('/application/documents', { method: 'POST', json: { kind, dataBase64: p.dataBase64, capture: p.capture } }); await onChange(); }
    catch (e) { setError((e as Error).message); setShots((s) => { const { [kind]: _x, ...rest } = s; return rest; }); } finally { setBusy(null); }
  };
  const done = need.every((n) => view.documents.includes(n.kind));
  return (
    <Card>
      <div className="space-y-4">
        <h2 className="text-title3 font-semibold">Verify your identity</h2>
        <p className="text-subhead text-label2">Take a photo of your ID and a selfie with your camera. Fit the whole ID in the frame, flat, with the text readable. Photos from your gallery can’t be used. They are encrypted and only used to verify who you are.</p>
        <ul className="space-y-3">
          {need.map((n) => (
            <li key={n.kind}><IdCamera label={n.label} hint={n.hint} facing={n.facing} frame={n.frame} disabled={busy !== null} done={view.documents.includes(n.kind)} value={shots[n.kind] ?? null} onChange={(p) => void upload(n.kind, p)} /></li>
          ))}
        </ul>
        {busy && <p className="text-footnote text-label2" role="status">Saving the photo…</p>}
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2"><Button variant="secondary" onClick={onBack}>Back</Button><Button className="flex-1" disabled={!done || busy !== null} onClick={onDone}>Continue</Button></div>
      </div>
    </Card>
  );
}

/** The coverage service, asked through this shop's own API; the browser never calls the CRM or the service directly. */
const fiberApi = (applicationId: string): FiberApi => ({
  qualify: (p) => api('/fiber/qualify', { method: 'POST', json: p }),
  reserve: (p) => api('/fiber/reserve', { method: 'POST', json: { ...p, sessionRef: applicationId } }),
  release: (id) => api(`/fiber/release/${id}`, { method: 'POST', json: {} }),
  waitlist: (p) => api('/fiber/waitlist', { method: 'POST', json: p }),
});
/** The speed a fibre plan in the basket names ("Home Fibre 1 Gbps"), so the check can ask for it. */
const fiberSpeed = (v: View): number | undefined => {
  for (const l of v.quote?.lines ?? []) { const m = /(\d+(?:\.\d+)?)\s*(g|m)bps/i.exec(l.name); if (m) return Math.round(Number(m[1]) * (m[2]!.toLowerCase() === 'g' ? 1000 : 1)); }
  return undefined;
};

function AddressForm({ view, onDone }: { view: View; onDone: () => void | Promise<void> }) {
  const { regional, modules } = useConfig();
  const installing = !!view.quote?.requiresInstallation;
  const [lock, setLockRaw] = useState<string | null>(view.fiber?.reservationId ?? null);
  const a = view.address ?? {};
  const [f, setF] = useState({ line1: a.line1 ?? '', line2: a.line2 ?? '', city: a.city ?? '', state: a.state ?? '', postcode: a.postcode ?? '', country: a.country ?? regional.country });
  const { busy, error, run } = useSave(onDone);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  // The held port goes onto the application, so checkout can confirm it for the order.
  const setLock = (id: string | null) => { setLockRaw(id); void api('/application', { method: 'PATCH', json: { fiber: id ? { reservationId: id } : null } }).catch(() => {}); };
  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(() => api('/application', { method: 'PATCH', json: { address: { ...f, line2: f.line2 || undefined, state: f.state || undefined } } })); }}>
        <h2 className="text-title3 font-semibold">{installing && !view.quote?.requiresShipping ? 'Where should we install?' : 'Where should we deliver?'}</h2>
        <Field label="Address line 1"><Input autoComplete="address-line1" required value={f.line1} onChange={set('line1')} /></Field>
        <Field label="Address line 2 (optional)"><Input autoComplete="address-line2" value={f.line2} onChange={set('line2')} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="City"><Input autoComplete="address-level2" required value={f.city} onChange={set('city')} /></Field>
          <Field label="Postcode"><Input autoComplete="postal-code" required value={f.postcode} onChange={set('postcode')} /></Field>
          <Field label="State / region (optional)"><Input autoComplete="address-level1" value={f.state} onChange={set('state')} /></Field>
          <Field label="Country (2-letter code)"><Input autoComplete="country" required maxLength={2} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} /></Field>
        </div>
        {installing && modules?.fiberCoverage && (
          <FiberCoverageCheck who="you" address={[f.line1, f.line2, f.city, f.postcode].filter(Boolean).join(', ')} speedMbps={fiberSpeed(view)} lock={lock} onLock={setLock} api={fiberApi(view.id)} />
        )}
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={busy} className="w-full">{busy ? 'Saving…' : 'Continue'}</Button>
      </form>
    </Card>
  );
}

function Review({ view, onBack, onSubmitted }: { view: View; onBack: () => void; onSubmitted: () => void | Promise<void> }) {
  const { terms } = useConfig();
  const [accepted, setAccepted] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [credit, setCredit] = useState(false);
  const needsCredit = !!view.quote?.financing?.creditCheck;
  // The agreements for this sign-up, with the shopper's own details filled in (see Settings → Document templates in the CRM).
  const [agr, setAgr] = useState<{ required: boolean; agreements: AgreementView[] } | null>(null);
  const [signed, setSigned] = useState<SignedPayload | null>(null);
  useEffect(() => { let live = true; api('/application/agreements').then((r) => { if (live) setAgr(r); }).catch(() => { if (live) setAgr({ required: false, agreements: [] }); }); return () => { live = false; }; }, [view.id]);
  const needsSignature = !!agr?.required && !signed;
  const { busy, error, run } = useSave(onSubmitted);
  const link = (url: string | null, text: string) => (url ? <a href={url} target="_blank" rel="noreferrer" className="underline">{text}</a> : <>{text}</>);
  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/application', { method: 'PATCH', json: { consent: { acceptedTerms: accepted, privacyAccepted: privacy, marketingOptIn: marketing, ...(needsCredit ? { creditCheck: credit } : {}) }, ...(signed ? { agreement: { image: signed.image, versionIds: signed.versionIds, geo: signed.geo ?? undefined, signerName: view.personal.fullName } } : {}) } }); await api('/application/kyc', { method: 'POST', json: {} }); }); }}>
        <h2 className="text-title3 font-semibold">Check and confirm</h2>
        <dl className="grid gap-x-4 gap-y-1 text-subhead sm:grid-cols-[auto_1fr]">
          <dt className="text-label2">Name</dt><dd>{view.personal.fullName}</dd>
          <dt className="text-label2">Email</dt><dd>{view.personal.email}</dd>
          <dt className="text-label2">Mobile</dt><dd>{view.personal.phone}</dd>
          <dt className="text-label2">ID</dt><dd>{ID_LABEL[view.personal.idType ?? ''] ?? view.personal.idType} {view.personal.idNumberMasked}</dd>
          {view.address && <><dt className="text-label2">Deliver to</dt><dd>{[view.address.line1, view.address.line2, view.address.city, view.address.postcode].filter(Boolean).join(', ')}</dd></>}
        </dl>
        <label className="flex items-start gap-3"><input type="checkbox" required className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /><span className="text-subhead">I accept the {link(terms.termsUrl, 'terms and conditions')} (version {terms.version}).</span></label>
        <label className="flex items-start gap-3"><input type="checkbox" required className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} /><span className="text-subhead">I have read the {link(terms.privacyUrl, 'privacy notice')} and agree to my ID being checked to verify my identity.</span></label>
        {needsCredit && <label className="flex items-start gap-3"><input type="checkbox" required className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={credit} onChange={(e) => setCredit(e.target.checked)} /><span className="text-subhead">I agree to a credit check on my ID number, to decide how my device is paid for over the contract.</span></label>}
        <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} /><span className="text-subhead text-label2">Send me offers (optional).</span></label>
        {agr && agr.agreements.length > 0 && <AgreementSigner agreements={agr.agreements} required={agr.required} onChange={setSigned} who="you" />}
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2"><Button type="button" variant="secondary" onClick={onBack}>Back</Button><Button type="submit" className="flex-1" disabled={busy || !accepted || !privacy || needsSignature || (needsCredit && !credit)}>{busy ? 'Submitting…' : 'Submit for verification'}</Button></div>
      </form>
    </Card>
  );
}

function Approved({ onPayment, onError, inReview }: { onPayment: (p: PaymentStart) => void; onError: (m: string) => void; inReview?: boolean }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await api<{ payment: PaymentStart | null }>('/application/checkout', { method: 'POST', json: {} }); if (r.payment) onPayment(r.payment); else onPayment(undefined as never); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <div className="space-y-4 text-center">
        <h2 className="text-title2 font-semibold">{inReview ? 'Your ID is being checked' : 'You’re verified'}</h2>
        <p className="text-subhead text-label2">{inReview ? 'You don’t need to wait. Review your order above and pay now: we switch your service on as soon as the check is approved. If it can’t be approved, the order is cancelled and you are refunded in full.' : 'Review your order above, then continue to payment.'}</p>
        <Button onClick={go} disabled={busy} className="w-full">{busy ? 'Please wait…' : 'Continue to payment'}</Button>
      </div>
    </Card>
  );
}

function Done({ order, shipping }: { order: NonNullable<View['order']>; shipping: View['address'] }) {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Card>
        <div className="space-y-3 text-center" role="status">
          <div aria-hidden className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success/15 text-title2 text-success">✓</div>
          <h1 className="text-title1 font-bold">{['COMPLETED', 'ACTIVATED'].includes(order.state) ? 'You’re all set' : 'Order received'}</h1>
          {order.kycHold && <p className="rounded-control bg-surface2 p-3 text-subhead" role="note">We’re still checking your ID. Your service is switched on as soon as it is approved, usually within a few hours. If it can’t be approved you are refunded in full.</p>}
          <p className="text-body text-label2">Order {order.number ?? order.id.slice(0, 8).toUpperCase()} · {order.state.toLowerCase().replace(/_/g, ' ')}</p>
          <ul className="text-subhead">{order.lines.map((l) => <li key={l.name}>{l.name}{l.quantity > 1 ? ` × ${l.quantity}` : ''}</li>)}</ul>
          {order.numbers.length > 0 && <p className="rounded-control bg-surface2 p-3 text-subhead">Your new number: <strong className="tabular-nums">{order.numbers.join(', ')}</strong></p>}
          {order.trackingNumber && <p className="text-subhead">Tracking number: <strong>{order.trackingNumber}</strong></p>}
          {shipping && ['FULFILMENT', 'SHIPPED', 'PAID'].includes(order.state) && <p className="text-subhead text-label2">We’ll deliver to {shipping.line1}, {shipping.city}.</p>}
        </div>
      </Card>
      <Link href="/" className="block text-center text-subhead text-accent underline">Back to plans</Link>
    </div>
  );
}
