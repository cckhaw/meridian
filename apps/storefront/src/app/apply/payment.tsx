'use client';
import { Alert, Button, Field, Input } from '@meridian/ui';
import { useEffect, useRef, useState } from 'react';
import { useConfig } from '@/components/config';
import { api } from '@/lib/api';

export interface PaymentStart { gateway: string; ref: string; clientSecret?: string; publicConfig: Record<string, string>; amountMinor: number; currency: string }

let stripeLoader: Promise<any> | null = null;
const loadStripe = (): Promise<any> => {
  if ((window as any).Stripe) return Promise.resolve((window as any).Stripe);
  return (stripeLoader ??= new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = 'https://js.stripe.com/v3/'; s.async = true;
    s.onload = () => resolve((window as any).Stripe); s.onerror = () => { stripeLoader = null; reject(new Error('Could not load the payment form. Check your connection and try again.')); };
    document.head.appendChild(s);
  }));
};

/** Renders whichever gateway the CRM chose. Adding another gateway means adding one branch here and one adapter in the CRM. */
export function PaymentStep({ payment, onSubmitted, onRetry }: { payment: PaymentStart; onSubmitted: () => void; onRetry: () => void }) {
  const { money } = useConfig();
  return (
    <section aria-labelledby="pay-h" className="space-y-4">
      <h2 id="pay-h" className="text-title2 font-semibold">Pay {money(payment.amountMinor)}</h2>
      {payment.gateway === 'stripe' ? <StripeForm payment={payment} onSubmitted={onSubmitted} />
        : payment.gateway === 'test' ? <TestForm onSubmitted={onSubmitted} onRetry={onRetry} />
        : <Alert>This payment method is not supported by the store yet.</Alert>}
    </section>
  );
}

function StripeForm({ payment, onSubmitted }: { payment: PaymentStart; onSubmitted: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const elements = useRef<any>(null);
  const stripe = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false; let el: any;
    loadStripe().then((Stripe) => {
      if (cancelled || !mount.current) return;
      stripe.current = Stripe(payment.publicConfig.publishableKey);
      elements.current = stripe.current.elements({ clientSecret: payment.clientSecret });
      el = elements.current.create('payment'); el.mount(mount.current); el.on('ready', () => setReady(true));
    }).catch((e) => setError(e.message));
    return () => { cancelled = true; try { el?.destroy(); } catch { /* already gone */ } };
  }, [payment.clientSecret, payment.publicConfig.publishableKey]);

  const pay = async () => {
    setBusy(true); setError(null);
    const { error: err } = await stripe.current.confirmPayment({ elements: elements.current, confirmParams: { return_url: `${window.location.origin}/apply` }, redirect: 'if_required' });
    if (err) { setError(err.message ?? 'Your payment could not be completed.'); setBusy(false); } else onSubmitted(); // the CRM confirms via Stripe's webhook; the page then waits for it
  };
  return (
    <>
      <div ref={mount} aria-label="Card details" className="rounded-card bg-surface p-4 shadow-card" />
      {error && <Alert>{error}</Alert>}
      <Button onClick={pay} disabled={!ready || busy} className="w-full sm:w-auto">{busy ? 'Processing…' : 'Pay now'}</Button>
      <p className="text-footnote text-label2">Card details go straight to our payment provider; we never see or store them.</p>
    </>
  );
}

function TestForm({ onSubmitted, onRetry }: { onSubmitted: () => void; onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (outcome: 'succeed' | 'decline') => {
    setBusy(true); setError(null);
    try {
      await api('/application/payment-test', { method: 'POST', json: { outcome } });
      if (outcome === 'decline') { setError('The test card was declined. You can try again.'); onRetry(); } else onSubmitted();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <Alert tone="info">Test mode: no real money moves. Use the buttons to simulate the outcome.</Alert>
      <div className="grid gap-4 rounded-card bg-surface p-4 shadow-card sm:grid-cols-2">
        <Field label="Card number"><Input readOnly value="4242 4242 4242 4242" /></Field>
        <div className="grid grid-cols-2 gap-4"><Field label="Expiry"><Input readOnly value="12 / 34" /></Field><Field label="CVC"><Input readOnly value="123" /></Field></div>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run('succeed')} disabled={busy}>{busy ? 'Processing…' : 'Pay now'}</Button>
        <Button variant="secondary" onClick={() => run('decline')} disabled={busy}>Simulate a declined card</Button>
      </div>
    </>
  );
}
