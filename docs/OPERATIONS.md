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
| `MERIDIAN_SESSION_IDLE_MINUTES` / `_MAX_HOURS` | no | 30 minutes idle / 12 hours absolute. These are the defaults; **Settings → Security policy** overrides them once saved ([SECURITY.md](SECURITY.md)). |
| `MERIDIAN_LOCK_AFTER_FAILURES` / `_LOCK_MINUTES` | no | Lock an account after 5 failures for 15 minutes (defaults; Security policy overrides them). |
| `MERIDIAN_LOGIN_IP_LIMIT` / `_USER_LIMIT` | no | Failed sign-ins per 15 minutes per address (30) and per username (10), including usernames that do not exist. |
| `PG_POOL_MAX` | no | Connections per instance. Use 1-3 on serverless platforms. |
| `MERIDIAN_LOGICAL_SHARDS` | no | Logical shards (default 16, matching the partitions the migrations create). Read [SCALE.md](SCALE.md) before raising it. |
| `MERIDIAN_DASHBOARD_TTL` | no | Seconds the dashboard figures are cached (default 30 in production, 0 = always live elsewhere). |
| `MERIDIAN_SAP_COMPANY_CODE`, `MERIDIAN_SAP_TOKEN` | no | Default company code written to the SAP journal export (default `1000`), and the bearer token for REST delivery ([FINANCE.md](FINANCE.md)). |
| `FEATURE_FIBER_COVERAGE_MODULE_ENABLED` | no | Starting value of the fibre coverage module switch (`on`/`off`; unset means on). **Settings → Modules** overrides it. See [FIBER_COVERAGE.md](FIBER_COVERAGE.md). |
| `MERIDIAN_FIBER_URL`, `MERIDIAN_FIBER_API_KEY` | no | Where the separately deployed fibre coverage service is, and a key with the fibre scope from its hub. Without them the coverage check is unavailable (fibre plans can still be sold). |
| `MERIDIAN_OCS_*` | no | Tokens for the charging-system REST connector. You choose the name (it must start with `MERIDIAN_OCS_`, for example `MERIDIAN_OCS_TOKEN`) and enter it in Settings; the secret is never stored in the database ([OCS.md](OCS.md)). |
| `MERIDIAN_WFM_WEBHOOK_SECRET`, `MERIDIAN_WFM_*` | no | The secret (16+ characters) the field-service system signs its callbacks with, and the token for the field-service REST connector. The names are set in Settings → Cases and must start with `MERIDIAN_WFM_` ([CASES.md](CASES.md)). |
| `MERIDIAN_MIGRATION_S3_*`, `MERIDIAN_MIGRATION_DB_MAX_MB` | no | Object storage for large data-migration uploads, and the size limit when uploads go through the database (default 256 MB) ([MIGRATION.md](MIGRATION.md#object-storage-optional)). |
| `MERIDIAN_ALLOW_EMBEDDED_DB` | no | Production only: `true` allows the in-memory demo database when `DATABASE_URL` is unset. Never for real data; everything is lost on restart. |
| `MERIDIAN_ALLOW_DEMO_DATA` | no | Production only: `true` allows `MERIDIAN_SEED=demo` (fake customers). Never for real data. |
| `MERIDIAN_DATA_DIR` | no | Development only: persist the embedded database to this folder. Ignored when `DATABASE_URL` is set. |
| `MERIDIAN_API_URL`, `MERIDIAN_API_KEY` | store-front | Where the store-front finds the CRM's store API and the key it uses ([STOREFRONT.md](STOREFRONT.md)). |
| `TEMPORAL_ADDRESS` | order-service | Temporal server address for the order, billing, case and dunning workflows (default `localhost:7233`). The CRM works without Temporal. |
| `MONGO_URL` | catalog-service | MongoDB connection string for the catalog service (default `mongodb://localhost:27017/meridian_catalog`). |
| `PORT` | services | Listen port of `catalog-service` (default 4001) and `order-service` (default 4002). |
| `TEST_DATABASE_URL` | tests | Runs the core test suite on real Postgres instead of the embedded database. |

Dunning needs no variables of its own: its pay page address, QR merchant details and credit-bureau name are set in Settings ([DUNNING.md](DUNNING.md#qr-payment-links)).

**Settings that need no variables.** Early-termination rules ([LIFECYCLE.md](LIFECYCLE.md)), device financing and its credit bureau ([FINANCING.md](FINANCING.md)), the integration hub and the northbound API ([INTEGRATION_API.md](INTEGRATION_API.md)), and stock transfers (below) are configured in the CRM only.

**The data key signs and encrypts more than KYC data.** `MERIDIAN_DATA_KEY` (or `MERIDIAN_ID_PEPPER` when unset) also encrypts the secrets entered in the integration hub (credit bureau, field service, network, SAP keys, webhook and OAuth secrets, single sign-on client secrets, the directory service-account password and the SMS gateway token), signs the northbound access tokens (HS256) and the invoice download links. Changing it makes stored secrets unreadable and invalidates issued tokens and links, so back it up with the database. Hub secrets are write-only: no call ever returns them.

See `.env.example`.

## 2. Day-one runbook

1. Provision PostgreSQL. Set the variables above and deploy. Open the site: you should see the sign-in screen.
2. Sign in as the super user. Under **Users & roles**, create one **Administrator** for day-to-day administration, then use that account. Keep the super user for emergencies and for giving **Settings** and **Integration** (the permissions behind those two menus) to the roles that need them: an Administrator cannot, so nobody with `user:manage` can give themselves either.
3. **Define the catalog**: first review **Settings → Catalog** (offer types, including **Combinations**: pairs of offer types that cannot be sold in the same order, enforced on the order screen and by the order engine in every channel; and fulfilment options; collect in store is built in, and turn on stock tracking for SIM activation only if you count SIM cards), then Catalog → New offer, a short guided flow: network types, categories, groups, then offers with prices, contract terms, ETC rules and fulfilment. Activate what you want to sell. (`MERIDIAN_SEED=starter` loads a sample catalog to edit instead of starting empty.)
4. **Set up stores** (Stores): add each retail store (the system issues its id, for example `STORE-00001`) with its name, address and phone. Add any warehouses besides the main one under Inventory → Warehouses. Then **receive stock** for each warehouse and store (a store's id is its stock location id): one SKU at a time with **Receive stock**, or many at once with **Load in batch (CSV)** (see below). Write-offs and the stock history are described in *Inventory: warehouses, receipts and write-offs*.
5. **Create staff**: pick the roles (review what each role may do under Users & roles → Roles and permissions first, and add roles of your own with **New role** if the built-in ones do not fit); store users are assigned one of the stores you set up in step 4 (search it by id or name), dealers a dealer id. Each gets a one-time password and must change it at first sign-in. Retail store, call center and telesales staff each sign in with their own user, so every order carries the person who took it.
5a. **Set up dealers** (Dealers): create each dealer (the system issues its dealer id) and its agents. Dealer orders are placed in the CRM on the dealer’s behalf by *Dealer Desk* staff (or by a login bound to that dealer), who name the dealer and the agent who sold it.
6. **Create customers** and, for the self-serve portal, a portal login linked to one customer.
7. **Settings** (`settings:manage`; the super user, or a role the super user gave it to): set the currency and number/date format **before the first order** (the currency is locked once orders, invoices or payments exist), upload the logo and favicon (any picture up to 15 MB; you crop it to the preset size, 480×120 for the logo and 256×256 for the favicon, before it is saved) and pick a colour theme. Under **Markets** choose *One market* (the default; the whole CRM works in your Regional country) or *Several markets*, with each market's tax and dial code and a default market. Customer form fields and bill cycles are under **Customers** and **Bill cycles**. The service-lifecycle rules (voluntary suspension cap, credit thresholds, the dunning ladder, number quarantine (also under Settings → Numbers & SIMs), debt handling, exempt segments) are set through `GET/POST /api/settings/lifecycle`; there is no screen for them yet.
8. **Online store** (optional): see [STOREFRONT.md](STOREFRONT.md). Create an API key, switch on a payment gateway, deploy `apps/storefront`, and schedule `POST /api/jobs/expire-applications` hourly.
9. **Sign-in integrations** (optional): see [SECURITY.md](SECURITY.md#sign-in-integrations-integration--sign-in-and-identity). Schedule `POST /api/jobs/directory-sync` every 15 minutes (each directory syncs when its own interval is due) and `POST /api/jobs/deliver-otp` every minute to retry any one-time code the SMS gateway refused (both run for a service account whose role holds `settings:manage` or `integration:manage`).
10. Schedule the **bill run** and the **daily lifecycle job** (Billing page, or `POST /api/billing/run` and `POST /api/lifecycle/run` with a service account holding `billing:run`). The lifecycle job resumes voluntary suspensions that have ended, walks every account with an overdue invoice along the [dunning ladder](LIFECYCLE.md#c-dunning-ladder) (`POST /api/billing/dunning` runs the dunning part alone) releases quarantined numbers that have rested, expires port-in requests the donor never answered, restores rested IMSIs to the pool and expires stale number holds ([numbering](NUMBERING.md)). When Finance switches on the automatic close (Finance → SAP settings) the same job also exports the previous day's journals to SAP and reconciles them ([finance](FINANCE.md)). Set `MERIDIAN_SAP_TOKEN` if journals are delivered by REST. The same job approves commission earnings whose hold has passed, takes back commission for services that ended early, and (when switched on) closes the previous month on the 1st ([commission](COMMISSION.md)). All are safe to re-run. Nothing runs them by itself, so schedule them. Network, notification and collections instructions the lifecycle produces wait in `GET /api/lifecycle/outbox?pending=1` until an adapter delivers them and acknowledges with `POST /api/lifecycle/outbox/ack`.
11. Finance exports the **GL journal** (Finance → Export). Each export is a batch, never exported twice.

## 3. Day-to-day

- **Health**: `GET /api/health` (liveness, no dependencies) and `GET /api/ready` (checks the database). Wire your load balancer and uptime monitor to these.
- **Logs**: one JSON line per request (`method`, `path`, `status`, `ms`, `user`). No bodies, no personal data. Configuration problems and unexpected errors are logged with context.
- **Audit**: Users & roles changes (including every change to what a role may do), sign-ins and failures, denied attempts, payments, credit notes, bill runs, exports, service changes (suspensions, bars, terminations; the history of one service is on the service) and stock receipts and write-offs are in **Audit log** (`audit:read`).
- **Reconciliation**: Finance → Reconciliation checks the ledger against invoices and payments. Investigate before exporting if a check fails.
- **A seller sees "There are live offers, but none is sold in …" or no offers at all**: this only happens when **several markets** are switched on (Settings → Markets). The order screen then lists only the offers sold in the seller's market. An offer is sold in one market (Catalog → offer → Availability) and a login has a market too (Users & roles → Edit → Market). Make the two match, or switch Settings → Markets back to **one market**, where nothing is filtered by market. Changing a user signs them out, so they sign in again.
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

- **Settings**: currency and number/date format (choose before the first order), logo, favicon and theme, payment gateway, store-front API keys, the *require verified identity* option.
- **Catalog, stock, bundle discounts**, and the **cancellation rules** (the standard policy returns the first time it is needed).
- **Users and roles** (everyone is signed out), then **dealers and their agents**.
- **Outside the database**: update the store-front's API key and URL, and the Stripe webhook endpoint and signing secret if the deployment URL or secrets changed. Customers' old store-front orders and receipts no longer exist.

## Loading stock from a CSV file

Inventory → **Load in batch (CSV)** (needs the stock-write permission; a store user can only load their own store).

1. **Download the template.** *Template with all my SKUs* lists every SKU your offers, their colour/storage options and line items use, for the location you choose, with the quantity blank. *Empty template* is just the header.
2. **Fill it in.** Columns: `location_id` (a warehouse id such as `WH-MAIN`, or a store id; a switched-off warehouse is refused), `sku`, `quantity` (a whole number) and `action`: `RECEIVE` adds stock (the default), `REMOVE` writes stock off, `SET` is a stock count (on hand becomes this number). A row with no quantity is skipped, so leave the SKUs that did not arrive. Lines starting with `#` are ignored. Up to 5,000 rows per file.
3. **Check the file.** Nothing changes yet. Every row is marked Ready, Check (for example a SKU no offer uses, which may be a typo) or Problem, with the line number and the reason: unknown location, invalid SKU, not a whole number, the same SKU twice, or taking stock below what is reserved for orders.
4. **Load.** Stock is keyed by **location + SKU**: a row updates that one record (or creates it the first time), so a SKU can never appear twice at a location, and the import never changes the catalog. Because `RECEIVE` and `REMOVE` add and subtract, loading the **same file again** would count it twice, so the check warns "already loaded" and the load needs an explicit confirmation (a stock count with `SET` is safe to repeat and never warns). The file loads only if no row is a problem, and then all rows load together: a file is never half loaded. Reserved stock is never taken away, and the load is recorded in the audit log.

API: `GET /api/inventory/import-template[?skus=1&locationId=…]` and `POST /api/inventory/import` with `{ "csv": "...", "apply": false }` (check) or `true` (load).

## Inventory: warehouses, receipts and write-offs

Inventory has three views. **Stock** shows on-hand, reserved and available by location. **Warehouses** (Operations Support) lists the warehouse locations: add one, rename it, switch it off, or remove it. The main warehouse (`WH-MAIN`) is where online orders are fulfilled from and cannot be switched off or removed; any other warehouse can be removed once it holds nothing (write the stock off first). **History** lists every receipt, CSV load and write-off: who, when, how many, the reason, and what was on hand afterwards.

- **Load in batch (CSV)**: download the template, fill it in, check it, then load it (every row or none). Locations must be a switched-on warehouse or a store.
- **Receive stock**: one SKU at a time, with an optional note (a delivery note or PO number).
- **Write off**: needs the `inventory:writeoff` permission and a reason (damaged, lost, expired, stolen, a stock count that came up short, or other with an explanation). Stock reserved for orders cannot be written off. Reducing stock is only possible this way, so every reduction has a reason in the history.

The **Operations Support** role (`inventory-ops`) holds `inventory:write`, `inventory:writeoff` and `warehouse:manage`. Retail Store keeps `inventory:write` for its own store but not write-offs; grant `inventory:writeoff` to it under Users & roles if stores should write off their own stock. Stock movements made by orders (reserving, shipping, returns) are not part of this history.

## Moving stock between warehouses and stores

Inventory → **Transfers** (permission `inventory:transfer`: Operations Support and store managers). Stock is never in two places or in none:

1. **Request.** Choose where it comes from and where it goes, then add products (SKU and quantity) and/or SIM cards (a number to take that many free cards from the sender, or the card numbers). Nothing moves yet; the quantity must be free at the sender (stock reserved for orders cannot be moved). A SIM card in a request is held, so it cannot be sold meanwhile.
2. **Dispatch** (by the sender). The stock leaves the sender now and belongs to no place until it arrives. A SIM card on the road cannot be sold, swapped in or moved again.
3. **Receive** (by the receiver). Enter what arrived. Less than was sent is recorded as a discrepancy (a *short on arrival* line in the history), and a SIM card that did not arrive is written off as lost in transit.

A request can be **cancelled**; a transfer on the road can be **sent back**, which returns the stock to the sender. A store user can request transfers into or out of their own store, dispatch from it and receive into it, and nothing else. Every step is in the stock history (*Transferred out*, *Transferred in*, *Short on arrival*) and the audit log.

API: `GET /api/inventory/transfers`, `POST /api/inventory/transfers` (`{from, to, lines: [{sku, quantity}], sims: {count | iccids}, note}`), `POST …/{id}/dispatch`, `…/receive` (`{received: {SKU: n}, iccids}`), `…/cancel`, and `GET /api/inventory/transfer-places`.

**Where an order takes its SIM from.** A sale made at a store takes its physical SIM cards from that store's stock (a store seller's own store; for an administrator, the store chosen on the order). A sale that is not made at a store (call centre, self-serve, dealer) takes them from the warehouses, and a store's card is refused there. The card list in the new-order flow follows the same rule.
