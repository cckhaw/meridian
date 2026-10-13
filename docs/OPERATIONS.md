# Operating Meridian

## 1. Environment

Meridian refuses to serve traffic in production unless it is configured safely: every request returns `503` (only `/api/health` answers) and the reason is written to the server log.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL 14+ / AlloyDB. Migrations run automatically at start, serialised with an advisory lock so several instances can start together. |
| `MERIDIAN_SUPERUSER_USERNAME`, `MERIDIAN_SUPERUSER_PASSWORD` | yes | The super user. 12+ character password, not a common one. **Rotating either value signs the super user out everywhere.** |
| `MERIDIAN_ID_PEPPER` | yes | 16+ character secret for hashing ID documents (duplicate detection). Never change it after customers exist or duplicates stop being detected. |
| `MERIDIAN_PAYMENT_MODE` | no | `manual` (default in production) or `simulated` (development only). |
| `MERIDIAN_PAYMENT_WEBHOOK_SECRET` | no | Enables the generic payment webhook (section 4). |
| `MERIDIAN_STRIPE_SECRET_KEY`, `_PUBLISHABLE_KEY`, `_WEBHOOK_SECRET` | no | Enable Stripe for the store-front ([STOREFRONT.md](STOREFRONT.md#5-payments)). |
| `MERIDIAN_DATA_KEY` | no | Secret for encrypting KYC data (ID numbers, document images). Falls back to `MERIDIAN_ID_PEPPER`. **Back it up with the database; losing it makes stored identity data unreadable. Rotating it needs a re-encryption step.** |
| `MERIDIAN_SEED` | no | `none` (default in production), `starter`, `demo` (development only; blocked in production). |
| `MERIDIAN_SESSION_IDLE_MINUTES` / `_MAX_HOURS` | no | 30 minutes idle / 12 hours absolute. |
| `MERIDIAN_LOCK_AFTER_FAILURES` / `_LOCK_MINUTES` | no | Lock an account after 5 failures for 15 minutes. |
| `MERIDIAN_LOGIN_IP_LIMIT` / `_USER_LIMIT` | no | Failed sign-ins per 15 minutes per address (30) and per username (10), including usernames that do not exist. |
| `PG_POOL_MAX` | no | Connections per instance. Use 1-3 on serverless platforms. |

See `.env.example`.

## 2. Day-one runbook

1. Provision PostgreSQL. Set the variables above and deploy. Open the site: you should see the sign-in screen.
2. Sign in as the super user. Under **Users & roles**, create one **Administrator** for day-to-day administration, then use that account. Keep the super user for emergencies.
3. **Define the catalog** (Catalog → Create or edit offers): network types, categories, groups, then offers with prices, contract terms, ETC rules and fulfilment. Activate what you want to sell. (`MERIDIAN_SEED=starter` loads a sample catalog to edit instead of starting empty.)
4. **Receive stock** (Inventory → Goods receipt) for each warehouse and store location. Store ids (for example `STORE-SG-001`) are the location ids.
5. **Create staff**: pick the roles; store users need a store id, dealers a dealer id. Each gets a one-time password and must change it at first sign-in. Retail store, call center and telesales staff each sign in with their own user, so every order carries the person who took it.
5a. **Set up dealers** (Dealers): create each dealer (the system issues its dealer id) and its agents. Dealer orders are placed in the CRM on the dealer’s behalf by *Dealer Desk* staff (or by a login bound to that dealer), who name the dealer and the agent who sold it.
6. **Create customers** and, for the self-serve portal, a portal login linked to one customer.
7. **Settings** (super user): set the currency and number/date format **before the first order** (the currency is locked once orders, invoices or payments exist), upload the logo and pick a colour theme.
8. **Online store** (optional): see [STOREFRONT.md](STOREFRONT.md). Create an API key, switch on a payment gateway, deploy `apps/storefront`, and schedule `POST /api/jobs/expire-applications` hourly.
9. Schedule the **bill run** and **dunning** (Billing page, or `POST /api/billing/run` and `/api/billing/dunning` with a service account holding `billing:run`). They are safe to re-run.
10. Finance exports the **GL journal** (Finance → Export). Each export is a batch, never exported twice.

## 3. Day-to-day

- **Health**: `GET /api/health` (liveness, no dependencies) and `GET /api/ready` (checks the database). Wire your load balancer and uptime monitor to these.
- **Logs**: one JSON line per request (`method`, `path`, `status`, `ms`, `user`). No bodies, no personal data. Configuration problems and unexpected errors are logged with context.
- **Audit**: Users & roles changes, sign-ins and failures, denied attempts, payments, credit notes, bill runs, exports and service changes are in **Audit log** (`audit:read`).
- **Reconciliation**: Finance → Reconciliation checks the ledger against invoices and payments. Investigate before exporting if a check fails.
- **Locked user**: Users & roles → Unlock. **Lost password**: Reset password issues a new one-time password and signs the user out everywhere.
- **Leaver**: set the user to Disabled; their sessions end immediately.

## 4. Payments

Meridian never holds card data. Three supported paths:

**Online store-front** (Stripe, extensible to other gateways): see [STOREFRONT.md](STOREFRONT.md#5-payments).

**Staff-recorded (default).** A cashier who holds `order:payment` takes payment on your terminal or in cash and records the approval code or receipt number on the order or invoice. The reference is mandatory and is the audit evidence.

**Payment-provider webhook** (online or portal payments). Set `MERIDIAN_PAYMENT_WEBHOOK_SECRET` and have your payment provider integration call:

```
POST /api/webhooks/payment
x-meridian-signature: sha256=<hex HMAC-SHA256 of the raw request body, key = the secret>
{ "kind": "order" | "invoice", "id": "<uuid>", "amountMinor": 12345, "reference": "PSP-REF-1",
  "method": "CREDIT_CARD" | "QR" | "CASH", "timestamp": <unix ms> }
```

The amount must equal the order total; the timestamp must be within 5 minutes; confirmation is idempotent per `reference`. Orders wait in `PAYMENT_PENDING` until confirmed. Until you connect a provider, portal customers can place orders but not pay them online.

## 5. Data and scale

- **Backups**: use your database platform's point-in-time recovery. Meridian keeps no state outside PostgreSQL.
- **Sharding**: every customer-owned row carries `shard_id` (`sha256(customer_id) % shards`). The shipped migration creates partitions for shards 0-15 (development size) and `MERIDIAN_LOGICAL_SHARDS` defaults to 16. For a larger deployment, create the partitions for your shard count (see `0001_create_shard_partitions.sql`) **before** raising it, and map shards to clusters with `shard_map`. Moving a customer between shards is not automated.
- **Phone numbers** are claimed globally in `identifier_registry` so they stay unique across shards.
- **Bill runs** bill each account in its own transaction; one failing account is reported and does not stop the run. Large fleets (IoT) bill as one line per offer.

## 6. Upgrading

Migrations are append-only SQL in `packages/db/migrations`, embedded at build time (`pnpm --filter @meridian/db embed`). They run at start. Deploy the new version; there is no separate migration step. Take a backup first.

## 7. Starting fresh (reset checklist)

Use this to throw away all data, for example to clear a trial or demo system before real use. **Resetting destroys customers, orders, invoices, the ledger and the audit log, and it cannot be undone.** Never run it on a system with real customers unless you have a backup you have tested.

### Preferred: point the app at a new, empty database

1. **Create an empty PostgreSQL database** (for Neon, a new project or database; do not *branch* the old one, a branch copies its data).
2. **Set the environment** (Vercel → Settings → Environment Variables, or your host's equivalent):
   - `DATABASE_URL`: the new database's connection string.
   - `MERIDIAN_SEED`: `none` (empty) or `starter` (a sample catalog and stock to edit). Never `demo` in production.
   - Keep `MERIDIAN_SUPERUSER_USERNAME` and `MERIDIAN_SUPERUSER_PASSWORD`, `MERIDIAN_ID_PEPPER` and the other secrets in section 1. If you change `MERIDIAN_ID_PEPPER` or the field-encryption key, nothing from the old database can be read with it, which is fine for a true reset.
3. **Redeploy or restart.** Migrations run automatically at start; the first request takes a few seconds.
4. **Check it is empty**: sign in as the super user; Customers and Orders show nothing.
5. **Keep the old database** until you are sure you do not need it, then delete it.

### Only if you must reuse the same database

1. **Back up first** (a snapshot or point-in-time restore point) and confirm you can restore it.
2. Stop traffic (pause the deployment or put up a maintenance page).
3. In the database console run `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`.
4. Set `MERIDIAN_SEED` as above, then redeploy or restart so the migrations recreate everything.

### What is lost and what to set up again

Everything lives in the database, so after a reset you start from section 2:

- **Settings**: currency and number/date format (choose before the first order), logo and theme, payment gateway, store-front API keys, the *require verified identity* option.
- **Catalog, stock, bundle discounts**, and the **cancellation rules** (the standard policy returns the first time it is needed).
- **Users and roles** (everyone is signed out), then **dealers and their agents**.
- **Outside the database**: update the store-front's API key and URL, and the Stripe webhook endpoint and signing secret if the deployment URL or secrets changed. Customers' old store-front orders and receipts no longer exist.
