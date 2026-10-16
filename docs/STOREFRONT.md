# Store-front, KYC and online payments

Meridian ships a **separate, self-service store-front** (`apps/storefront`) and a **store API** in the CRM that it talks to. The store-front holds no customer data and no business rules: it renders pages and calls the CRM over REST with an API key, so it can be hosted anywhere (another Vercel project, another cloud, a CDN-fronted container) independently of the CRM.

```
 Shopper's browser ──►  Store-front (Next.js, apps/storefront)  ──►  CRM store API  (/api/store/*)
                         • pages, wizard, theme                      • catalog, pricing, dependency checks
                         • HttpOnly cookie = application id+token    • applications, KYC, customers, orders
                         • holds MERIDIAN_API_KEY (server only)      • payment gateways + signed webhooks
                                                      Stripe ──► webhook ──► CRM  /api/webhooks/gateway/stripe
```

The browser never sees the API key, the CRM address or the application token. Prices are always computed in the CRM; nothing a browser sends about money is used.

## 1. What the shopper does

1. **Browse** SIM-only plans, SIM + device plans, add-ons and goods (`GET /store/catalog`). Only active offers that are sold through the *Self-serve* channel (or have no channel restriction) and whose whole hierarchy is active are shown.
2. **Build a basket.** Prerequisites configured in the catalog (for example *Device Care requires any Device*) are enforced: the basket is totalled by `POST /store/quote`, which reports unmet prerequisites and conflicts.
3. **Sign up**: details → ID photos (front, back, selfie) → delivery address (only if something ships) → review, accept terms and privacy notice → **submit for verification**.
4. **KYC.** Automatic rules reject the obvious (under the minimum age, expired ID) and flag the doubtful (an ID already registered to another customer). A compliance officer then approves, rejects or sends it back for corrections (*manual* mode), or clean applications are approved by the rules alone (*automatic* mode, meant for use with an eKYC provider). The page updates by itself.
5. **Pay** through the gateway the CRM selects (Stripe Payment Element). The order is confirmed **only** by the gateway’s signed webhook, never by the browser.
6. The CRM creates the customer (verified), account and order (`SELF_SERVE` channel) and runs the normal order flow: stock, shipping, activation, billing. The shopper sees the order state, tracking number and new phone number.

## 2. Deploying the store-front

It is an ordinary Next.js app. Required **server-side** environment variables (never `NEXT_PUBLIC_`):

| Variable | Purpose |
|---|---|
| `MERIDIAN_API_URL` | CRM API base, e.g. `https://crm.example.com/api` |
| `MERIDIAN_API_KEY` | a key created in the CRM under **Integration → Online store-front → API keys** |

On Vercel: create a second project from the same repository, set *Root Directory* to `apps/storefront`, add the two variables, deploy. Locally: `pnpm --filter @meridian/storefront dev` (port 3100) with the two variables set; the CRM runs on 3000.

The storefront reads brand name, logo, favicon, theme colours, currency and number format from the CRM (Settings → Appearance / Regional format), so it always matches the operator’s portal. It needs no database.

### Setting up the CRM side

1. Settings → **Store-front**: choose KYC mode, minimum age, terms/privacy links and version, and which payment gateways are on.
2. Create an **API key** per store-front (shown once; revoke at any time).
3. Make sure the offers you want online are **Active** and either have no channel list or include *Self serve* (edit the offer → *Sold through*).
4. Create a **KYC Compliance Officer** user (role `compliance`, home screen *KYC reviews*), or grant `kyc:review` to your own role.
5. Schedule `POST /api/jobs/expire-applications` hourly (needs `billing:run`, like the bill run). It closes stale sign-ups and cancels orders whose online payment never arrived (after 24 hours).

## 3. Store API contract

Base: `${MERIDIAN_API_URL}`. Every call carries `Authorization: Bearer mk_…`. JSON in, JSON out; errors are `{ "error": { "code", "message" } }` with the usual HTTP statuses (400 validation, 401 bad key, 404 unknown or not yours, 422 business rule, 429 throttled). Calls are **server-to-server**: there is no CORS, by design.

A shopper’s application is private to the key that created it **and** to its token: `POST /store/applications` returns `{ id, token, expiresAt }`; send the token as `x-application-token` on every later call for that application. The reference store-front keeps `id.token` in an HttpOnly cookie. Unknown id, wrong token and another client’s application all return the same `404`.

| Method and path | Purpose |
|---|---|
| `GET /store/config` | brand, theme, regional format, KYC rules, terms version/links, enabled payment gateways (with *public* config only, such as Stripe’s publishable key) |
| `GET /store/catalog` | sellable offers with gross prices (`monthlyMinor`, `upfrontMinor`), contract months, prerequisites (`requires`, `requiresText`), shipping flag |
| `POST /store/quote` `{ lines:[{offerId,quantity?}] }` | totals and `violations[]` for a basket |
| `POST /store/applications` `{ lines }` | start a sign-up. Optional header `x-shopper-ip` (used only to throttle abuse: 20 sign-ups per address per hour) |
| `GET /store/applications/:id` | everything the shopper may see: status, quote, details (ID number masked), documents present, KYC outcome and reason, consent, order and its progress |
| `PATCH /store/applications/:id` `{ lines?, personal?, address?, consent? }` | edit while `DRAFT`. Saving details creates the KYC case |
| `POST /store/applications/:id/documents` `{ kind, dataBase64 }` | `ID_FRONT`, `ID_BACK`, `SELFIE`, `PROOF_OF_ADDRESS`. JPEG/PNG/WebP/PDF, ≤ 2.5 MB (checked by file signature, not by claimed type). One per kind; a new upload replaces |
| `POST /store/applications/:id/kyc` | submit for verification → `KYC_REVIEW`, `KYC_APPROVED` or `KYC_REJECTED` |
| `POST /store/applications/:id/checkout` `{ gateway?, returnUrl? }` | needs `KYC_APPROVED` and accepted terms. Creates customer + order atomically (retry-safe: same answer) and starts payment. Returns `{ application, payment }`; `payment` is `null` when nothing is due |
| `POST /store/applications/:id/payment` | start a new payment attempt (after a failure or reload) |
| `POST /store/applications/:id/cancel` | cancel, releasing any unpaid order |

Application statuses: `DRAFT` → `KYC_REVIEW` → `KYC_APPROVED` | `KYC_REJECTED` → `ORDERED`; also `CANCELLED`, `EXPIRED`. A reviewer sending a case back returns it to `DRAFT` with the reason in `kyc.reason`.

`payment` = `{ gateway, ref, clientSecret?, redirectUrl?, publicConfig, amountMinor, currency }`. For `stripe`, pass `clientSecret` and `publicConfig.publishableKey` to Stripe.js.

## 4. KYC

> The identity workflow (camera-only photographs, the vault, the review queue, holding activation for the order) is described in [KYC.md](KYC.md); the points below predate it where they differ. In particular the shopper no longer waits for a clean review before paying, and *Require verified identity before selling any service* is now *When identity must be settled*.

- **Rules** (all configurable in Settings): minimum age; ID expiry; required documents (`ID_FRONT` + `SELFIE`, plus `ID_BACK` unless a passport); duplicate identity.
- **Duplicate identity.** An online applicant whose ID already belongs to a customer is flagged and **cannot be approved online**: attaching them to that customer’s account would bill the real owner. The officer rejects (the customer can visit a store) or sends it back. The applicant is told to visit a store; the existing customer’s id is never revealed.
- **What is stored.** The ID number and every image are encrypted (AES-256-GCM, key derived from `MERIDIAN_DATA_KEY`, falling back to `MERIDIAN_ID_PEPPER`); a keyed hash is kept for duplicate detection and a masked form for display. Opening a case or a document is written to the audit log. The customer record keeps only `kyc_status` and `kyc_verified_at`.
- **Reviewers** (`kyc:review`) see the full ID number and images in **KYC reviews**. Someone who attested a case in store cannot also approve it.
- **Enforcing KYC everywhere.** Settings → *Require verified identity before selling any service* makes every channel, including staff orders in the CRM, refuse services for unverified customers. Turn it on once existing customers are verified.
- **Plugging in an eKYC vendor.** Set mode to *automatic* and have the vendor’s result decide before `POST …/kyc` (or extend `submitRemote` in `packages/core/src/kyc.ts`, which is the single place that turns evidence into a decision).

## 5. Payments

Gateways implement one interface (`packages/core/src/gateways.ts`): `configured()`, `publicConfig()`, `createIntent()`, `verifyWebhook()`. The store, applications and orders know nothing else about a provider.

**Stripe** (included; plain REST and signed webhooks, no SDK):

1. Server environment: `MERIDIAN_STRIPE_SECRET_KEY` (`sk_…`), `MERIDIAN_STRIPE_PUBLISHABLE_KEY` (`pk_…`), `MERIDIAN_STRIPE_WEBHOOK_SECRET` (`whsec_…`).
2. Stripe Dashboard → Developers → Webhooks → endpoint `https://<crm>/api/webhooks/gateway/stripe`, events `payment_intent.succeeded` and `payment_intent.payment_failed`.
3. Integration → Stripe → *Where each gateway is used* → tick Store-front (and choose a default).

Safety properties: the amount charged is the order total computed in the CRM; the webhook must carry a valid `Stripe-Signature` (HMAC-SHA256, 5-minute tolerance); the reported amount and currency must equal the payment intent or the event is refused and audited; every event id is processed once (replays are ignored); an already-paid order is never captured twice. Card numbers never reach Meridian or the store-front (Stripe’s Payment Element runs in Stripe’s iframe; the store-front’s CSP allows only `js.stripe.com` and Stripe frames).

**Test gateway.** In development (`MERIDIAN_PAYMENT_MODE=simulated`, never in production) a *Test payments* gateway lets you pay or decline with buttons.

**Adding a second gateway** (for example PayPal, Adyen, a local PSP): implement `PaymentGateway`, add it to `GATEWAYS`, add one branch in `apps/storefront/src/app/apply/payment.tsx` to render its checkout, and point the provider’s webhook at `/api/webhooks/gateway/<id>`. Settings lists it automatically; operators switch it on and pick the default. No other code changes.

Currency: the gateway receives the order’s currency and integer minor-unit amount. Stripe’s zero-decimal and three-decimal rules match ISO 4217 for the common currencies; check Stripe’s currency table for edge cases (for example ISK, UGX, HUF) before enabling them.

## 6. Assisted sales (customer in the store)

Every order taken in the CRM is an assisted sale, so there is no separate menu for it: staff use **New order** and the **Selling through** panel there (see [Orders](ORDERS.md#selling-through)). The customer is found or created by ID in the order wizard and KYC rules apply as for any order.

The step-by-step assisted-application API (`/api/assisted/*`: ID sighting, signed consent, checkout) is still served for integrations, but the CRM no longer has a screen for it.

## 7. Limits of this release

- New-customer sign-up and assisted sales to existing customers are supported. **Existing customers buying online** (adding a product to their own account) need a customer login on the store-front; that is not included, because it must not be possible to add services to someone else’s account by knowing their ID.
- No number porting (MNP) or number choice in the store-front; new numbers are allocated at activation.
- Recurring-payment tokenisation (auto-debit of monthly bills) is not set up; the first payment covers the upfront amount, bills are issued normally.
- KYC documents are stored (encrypted) in the database. For large volumes move them to object storage with a retention policy; the encryption and audit stay the same.
- No SMS/email notifications; the shopper sees status on the page.

## Markets

With the default *one market* setting the store sells every active offer and works in the deployment's own country. With *several markets* switched on (Settings → Markets), a store sale belongs to the **default market** (or, for an existing customer, that customer's market), only offers sold in that market are shown, and its tax and dial code apply. The deployment still has one currency.
