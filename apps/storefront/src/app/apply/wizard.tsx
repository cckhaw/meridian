'use client';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfig } from '@/components/config';
import { api, ApiError } from '@/lib/api';
import { PaymentStep, type PaymentStart } from './payment';

interface View {
  id: string; status: string; expiresAt: string;
  quote: { lines: Array<{ offerId: string; name: string; quantity: number; upfrontMinor: number; monthlyMinor: number; deal?: { planName: string; termMonths: number } }>; upfrontMinor: number; monthlyMinor: number; requiresShipping: boolean; taxName: string } | null;
  personal: Record<string, string | undefined>; personalProblems: string[]; address: Record<string, string> | null; consent: Record<string, unknown> | null;
  kyc: { status: string; method: string; reason: string | null; returned: boolean } | null; documents: string[];
  order: { id: string; state: string; totalMinor: number; trackingNumber: string | null; failureReason: string | null; numbers: string[]; lines: Array<{ name: string; quantity: number }> } | null;
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
    if (view.quote?.requiresShipping && !view.address) return 'address';
    return 'review';
  }, [view]);
  // Stay on the documents step while photos are added, instead of jumping ahead the moment the last one lands.
  useEffect(() => { if (step === null && next === 'documents') setStep('documents'); }, [step, next]);
  const current: Step = step ?? next;

  if (missing) return <Card><p className="mb-4">You don’t have a sign-up in progress.</p><Link href="/" className="inline-flex min-h-tap items-center rounded-control bg-accent px-5 font-medium text-accent-fg">Choose a plan</Link></Card>;
  if (!view) return error ? <Alert>{error}</Alert> : <Spinner />;

  const header = <Summary view={view} />;

  // ── outcomes outside the form ──
  if (view.status === 'KYC_REVIEW') return <Outcome title="We’re checking your ID" body="A team member is reviewing your documents. This page updates by itself; you can also come back later with the same browser." busy>{header}</Outcome>;
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
  const approved = view.status === 'KYC_APPROVED';
  const stepNo = approved ? 4 : ({ details: 1, documents: 2, address: 3, review: 3 } as const)[current];
  return (
    <div className="mx-auto max-w-xl space-y-5">
      <Stepper at={stepNo} />
      {view.kyc?.returned && <Alert tone="info">Please update your details: {view.kyc.reason}</Alert>}
      {header}
      {error && <Alert>{error}</Alert>}
      {approved
        ? <Approved onError={setError} onPayment={(p) => { setPayment(p); void refresh(); }} />
        : current === 'details' ? <Details view={view} onDone={async () => { setStep(null); await refresh(); }} />
        : current === 'documents' ? <Documents view={view} onChange={refresh} onBack={() => setStep('details')} onDone={() => setStep(null)} />
        : current === 'address' ? <AddressForm view={view} onDone={async () => { setStep(null); await refresh(); }} />
        : <Review view={view} onBack={() => setStep(view.quote?.requiresShipping ? 'address' : 'documents')} onSubmitted={async () => { setStep(null); await refresh(); }} />}
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
        {q.lines.map((l) => <li key={l.offerId} className="flex justify-between gap-3"><span>{l.name}{l.quantity > 1 ? ` × ${l.quantity}` : ''}{l.deal && <span className="block text-footnote text-label2">On a {l.deal.termMonths}-month contract with {l.deal.planName}</span>}</span><span className="tabular-nums text-label2">{l.monthlyMinor ? `${money(l.monthlyMinor)}/mo` : money(l.upfrontMinor)}</span></li>)}
      </ul>
      <p className="mt-2 border-t border-separator pt-2 text-subhead font-medium">Due today <span className="float-right tabular-nums">{money(q.upfrontMinor)}</span></p>
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

const readBase64 = (file: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader(); r.onerror = () => reject(new Error('Could not read that file.'));
  r.onload = () => resolve(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(file);
});
/** Phone photos are huge; shrink to a sensible size client-side so uploads are fast and under the limit. */
async function prepare(file: File, maxBytes: number): Promise<string> {
  if (file.type === 'application/pdf') { if (file.size > maxBytes) throw new Error('That PDF is too large.'); return readBase64(file); }
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('That file is not a photo we can read. Use a JPEG or PNG.');
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.85));
  if (!blob || blob.size > maxBytes) throw new Error('That photo is still too large. Try a smaller one.');
  return readBase64(blob);
}

function Documents({ view, onChange, onBack, onDone }: { view: View; onChange: () => Promise<unknown>; onBack: () => void; onDone: () => void }) {
  const { kyc } = useConfig();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const need: Array<[string, string, string]> = [
    ['ID_FRONT', `Front of your ${ID_LABEL[view.personal.idType ?? ''] ?? 'ID'}`, 'environment'],
    ...(view.personal.idType === 'PASSPORT' ? [] : [['ID_BACK', 'Back of your ID', 'environment'] as [string, string, string]]),
    ['SELFIE', 'A selfie, face clearly visible', 'user'],
  ];
  const upload = async (kind: string, file?: File) => {
    if (!file) return;
    setBusy(kind); setError(null);
    try { await api('/application/documents', { method: 'POST', json: { kind, dataBase64: await prepare(file, kyc.maxDocumentBytes) } }); await onChange(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const done = need.every(([k]) => view.documents.includes(k));
  return (
    <Card>
      <div className="space-y-4">
        <h2 className="text-title3 font-semibold">Verify your identity</h2>
        <p className="text-subhead text-label2">Take or upload clear photos. All four corners of the ID must be visible and the text readable. Your documents are encrypted and only used to verify who you are.</p>
        <ul className="space-y-3">
          {need.map(([kind, label, cam]) => {
            const has = view.documents.includes(kind);
            return (
              <li key={kind} className="flex items-center gap-3 rounded-control border border-separator p-3">
                <span className="flex-1"><span className="block font-medium">{label}</span>{has ? <Badge tone="success">Uploaded</Badge> : <span className="text-footnote text-label2">JPEG, PNG or PDF</span>}</span>
                <label className="inline-flex min-h-tap cursor-pointer items-center rounded-control bg-surface2 px-4 text-subhead font-medium focus-within:ring-2 focus-within:ring-accent">
                  {busy === kind ? 'Uploading…' : has ? 'Replace' : 'Add photo'}
                  <input type="file" accept="image/*,application/pdf" capture={cam as 'user' | 'environment'} className="sr-only" aria-label={`${label}: choose file`} disabled={busy !== null} onChange={(e) => { void upload(kind, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </li>
            );
          })}
        </ul>
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2"><Button variant="secondary" onClick={onBack}>Back</Button><Button className="flex-1" disabled={!done || busy !== null} onClick={onDone}>Continue</Button></div>
      </div>
    </Card>
  );
}

function AddressForm({ view, onDone }: { view: View; onDone: () => void | Promise<void> }) {
  const { regional } = useConfig();
  const a = view.address ?? {};
  const [f, setF] = useState({ line1: a.line1 ?? '', line2: a.line2 ?? '', city: a.city ?? '', state: a.state ?? '', postcode: a.postcode ?? '', country: a.country ?? regional.country });
  const { busy, error, run } = useSave(onDone);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(() => api('/application', { method: 'PATCH', json: { address: { ...f, line2: f.line2 || undefined, state: f.state || undefined } } })); }}>
        <h2 className="text-title3 font-semibold">Where should we deliver?</h2>
        <Field label="Address line 1"><Input autoComplete="address-line1" required value={f.line1} onChange={set('line1')} /></Field>
        <Field label="Address line 2 (optional)"><Input autoComplete="address-line2" value={f.line2} onChange={set('line2')} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="City"><Input autoComplete="address-level2" required value={f.city} onChange={set('city')} /></Field>
          <Field label="Postcode"><Input autoComplete="postal-code" required value={f.postcode} onChange={set('postcode')} /></Field>
          <Field label="State / region (optional)"><Input autoComplete="address-level1" value={f.state} onChange={set('state')} /></Field>
          <Field label="Country (2-letter code)"><Input autoComplete="country" required maxLength={2} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} /></Field>
        </div>
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
  const { busy, error, run } = useSave(onSubmitted);
  const link = (url: string | null, text: string) => (url ? <a href={url} target="_blank" rel="noreferrer" className="underline">{text}</a> : <>{text}</>);
  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/application', { method: 'PATCH', json: { consent: { acceptedTerms: accepted, privacyAccepted: privacy, marketingOptIn: marketing } } }); await api('/application/kyc', { method: 'POST', json: {} }); }); }}>
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
        <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} /><span className="text-subhead text-label2">Send me offers (optional).</span></label>
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2"><Button type="button" variant="secondary" onClick={onBack}>Back</Button><Button type="submit" className="flex-1" disabled={busy || !accepted || !privacy}>{busy ? 'Submitting…' : 'Submit for verification'}</Button></div>
      </form>
    </Card>
  );
}

function Approved({ onPayment, onError }: { onPayment: (p: PaymentStart) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await api<{ payment: PaymentStart | null }>('/application/checkout', { method: 'POST', json: {} }); if (r.payment) onPayment(r.payment); else onPayment(undefined as never); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <div className="space-y-4 text-center">
        <h2 className="text-title2 font-semibold">You’re verified</h2>
        <p className="text-subhead text-label2">Review your order above, then continue to payment.</p>
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
          <p className="text-body text-label2">Order {order.id.slice(0, 8).toUpperCase()} · {order.state.toLowerCase().replace(/_/g, ' ')}</p>
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
