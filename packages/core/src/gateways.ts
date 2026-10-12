import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { paymentMode } from './config.js';
import { DomainError, invalid } from './errors.js';

/**
 * Payment gateways. The store only ever talks to this interface, so adding a second provider means writing one object that implements it
 * and adding it to `GATEWAYS`; nothing in applications, orders or the store API changes.
 *
 * Money is always integer minor units. A gateway never decides what to charge: the amount comes from the order and is re-checked when
 * the provider reports success.
 */
export interface CreateIntentInput { amountMinor: number; currency: string; reference: string; description: string; idempotencyKey: string; returnUrl?: string; metadata: Record<string, string> }
export interface CreatedIntent { ref: string; /** for the provider's browser SDK (Stripe.js) */ clientSecret?: string; /** for redirect-style providers */ redirectUrl?: string }
export interface GatewayEvent { eventId: string; type: 'payment.succeeded' | 'payment.failed'; ref: string; amountMinor: number; currency: string; reason?: string }

export interface PaymentGateway {
  id: string;
  label: string;
  /** Has everything it needs (keys) and is allowed in this environment. */
  configured(env?: NodeJS.ProcessEnv): boolean;
  /** Non-secret values the store-front needs to render the payment step (e.g. Stripe publishable key). */
  publicConfig(env?: NodeJS.ProcessEnv): Record<string, string>;
  createIntent(i: CreateIntentInput, env?: NodeJS.ProcessEnv): Promise<CreatedIntent>;
  /** Verifies the provider's signature on the raw body and returns the event, or null for event types we ignore. Throws on a bad signature. */
  verifyWebhook(raw: string, headers: (name: string) => string | null, env?: NodeJS.ProcessEnv, now?: number): GatewayEvent | null;
}

// ───────────────────────── Stripe (REST + signed webhooks, no SDK) ─────────────────────────
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
let httpFetch: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>;
/** Test seam: lets tests stand in for api.stripe.com. */
export const setGatewayFetch = (f: FetchLike | null) => { httpFetch = f ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>); };

const STRIPE_TOLERANCE_S = 300;
export const stripeGateway: PaymentGateway = {
  id: 'stripe',
  label: 'Stripe',
  configured: (env = process.env) => /^sk_(live|test)_/.test(env.MERIDIAN_STRIPE_SECRET_KEY ?? '') && (env.MERIDIAN_STRIPE_WEBHOOK_SECRET ?? '').startsWith('whsec_') && /^pk_(live|test)_/.test(env.MERIDIAN_STRIPE_PUBLISHABLE_KEY ?? ''),
  publicConfig: (env = process.env) => ({ publishableKey: env.MERIDIAN_STRIPE_PUBLISHABLE_KEY ?? '' }),
  async createIntent(i, env = process.env) {
    const form = new URLSearchParams({
      amount: String(i.amountMinor), currency: i.currency.toLowerCase(), description: i.description, 'automatic_payment_methods[enabled]': 'true',
    });
    for (const [k, v] of Object.entries({ ...i.metadata, reference: i.reference })) form.set(`metadata[${k}]`, v);
    const res = await httpFetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST', body: form.toString(),
      headers: { authorization: `Bearer ${env.MERIDIAN_STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': i.idempotencyKey },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.id || !j.client_secret) {
      console.error('[stripe] create intent failed', res.status, j?.error?.type, j?.error?.code);
      throw new DomainError('REJECTED', 'The payment provider could not start this payment. Please try again.');
    }
    return { ref: j.id, clientSecret: j.client_secret };
  },
  verifyWebhook(raw, header, env = process.env, now = Date.now()) {
    const secret = env.MERIDIAN_STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new DomainError('NOT_FOUND', 'not found');
    const parts = Object.fromEntries((header('stripe-signature') ?? '').split(',').map((p) => { const [k, ...v] = p.split('='); return [k!.trim(), v.join('=')]; }));
    const t = Number(parts.t);
    const sigs = (header('stripe-signature') ?? '').split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
    if (!t || !sigs.length || Math.abs(now / 1000 - t) > STRIPE_TOLERANCE_S) throw new DomainError('UNAUTHENTICATED', 'invalid signature');
    const want = createHmac('sha256', secret).update(`${t}.${raw}`).digest();
    const ok = sigs.some((s) => { const got = Buffer.from(s, 'hex'); return got.length === want.length && timingSafeEqual(got, want); });
    if (!ok) throw new DomainError('UNAUTHENTICATED', 'invalid signature');
    const ev = JSON.parse(raw);
    const obj = ev?.data?.object;
    if (ev.type === 'payment_intent.succeeded') return { eventId: ev.id, type: 'payment.succeeded', ref: obj.id, amountMinor: obj.amount_received ?? obj.amount, currency: String(obj.currency).toUpperCase() };
    if (ev.type === 'payment_intent.payment_failed') return { eventId: ev.id, type: 'payment.failed', ref: obj.id, amountMinor: obj.amount, currency: String(obj.currency).toUpperCase(), reason: obj.last_payment_error?.message };
    return null;
  },
};
/** Builds the `Stripe-Signature` header Stripe would send; used by tests and by anyone replaying events locally. */
export const stripeSignature = (raw: string, secret: string, at = Date.now()) => { const t = Math.floor(at / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`; };

// ───────────────────────── Test gateway (development only) ─────────────────────────
/** Pretend card payments for development: the store's "pay" step confirms or declines it directly. Never available in production. */
export const testGateway: PaymentGateway = {
  id: 'test',
  label: 'Test payments (no real money)',
  configured: (env = process.env) => paymentMode(env) === 'simulated' && env.NODE_ENV !== 'production',
  publicConfig: () => ({}),
  async createIntent() { const ref = `test_pi_${randomUUID().replaceAll('-', '')}`; return { ref, clientSecret: `${ref}_secret` }; },
  verifyWebhook() { throw new DomainError('NOT_FOUND', 'not found'); },
};

export const GATEWAYS: Record<string, PaymentGateway> = { stripe: stripeGateway, test: testGateway };
export const gatewayById = (id: string): PaymentGateway => { const g = GATEWAYS[id]; if (!g) throw invalid(`unknown payment gateway ${id}`); return g; };
