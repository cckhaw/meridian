# Meridian

CRM, order management, billing and finance for a telecom operator: customers and hierarchies, product catalog, orders and fulfilment,
subscription lifecycle (suspension, dunning, termination, port-out), bill runs and invoices, double-entry ledger with SAP export, cases, inventory with warehouses and write-offs, role-based access with roles you define,
an editable product hierarchy with dependencies between products, one-market or multi-market operation, regional/branding settings, and an independently hosted **self-service store-front**
with KYC onboarding, Stripe payments and assisted in-store sales. It also has rule-based dunning and collections, configurable early-termination formulas, device financing with a credit check, stock transfers between warehouses and stores, and a northbound integration layer (OAuth 2.0 / API keys, TM Forum APIs, signed webhooks and events) with an admin integration hub.

Sign-in is required. Staff and customers see only the modules and records their **role** allows ([docs/ROLES.md](docs/ROLES.md)).

## Run it locally

```bash
pnpm install
pnpm --filter @meridian/web dev         # CRM        http://localhost:3000
pnpm --filter @meridian/storefront dev  # store-front http://localhost:3100 (needs MERIDIAN_API_URL and MERIDIAN_API_KEY, see docs/STOREFRONT.md)
```

Sign in as `admin` / `local-dev-only-Passphrase-1` (from `apps/web/.env.development`, development only). With no `DATABASE_URL` it runs an
embedded PostgreSQL seeded with sample data. Then create staff under **Users & roles** and sign in as them to see each role’s view.

```bash
pnpm typecheck && pnpm test          # 649 tests; set TEST_DATABASE_URL=postgres://.../postgres to run the core suite on real Postgres
```

## Run it in production

Set `DATABASE_URL`, `MERIDIAN_SUPERUSER_USERNAME`, `MERIDIAN_SUPERUSER_PASSWORD` and `MERIDIAN_ID_PEPPER`, deploy, and follow the
[day-one runbook](docs/OPERATIONS.md). Meridian refuses to serve traffic if these are missing or weak.

## Design principles

- **Configure, don't deploy.** Business rules are data edited in **Settings** (dunning ladders, early-termination formulas, financing bands, cancellation terms, numbering, cases, integrations), versioned and audited. The environment holds only secrets and deployment wiring; see [Operating Meridian](docs/OPERATIONS.md#1-environment).
- **Safe by default, opt-in to change.** New engines are off or inert until switched on (ETC rules, the credit check, dunning rules fall back to the older ladder), so an upgrade never changes prices or collections by itself.
- **One place decides.** Price, eligibility and payment structure come from one pricing function that the quote, the order and the store-front all use. Clients never send money amounts.
- **Money is integer minor units**; every change that other systems need goes through a transactional **outbox** (network, notifications, collections, GL, events) and is delivered with retries.
- **Privacy by construction.** ID numbers are hashed or encrypted, never logged or returned; integration secrets are encrypted and write-only; consent is recorded before personal data leaves for a third party.
- **Every action is permissioned and audited**, in the CRM and through the API (scopes, rate limits, idempotency keys, a call log).
- **Plain-language, accessible UI** that works on a phone: Settings screens explain what a setting does before asking for it.

## Configuration at a glance

Environment variables are in [docs/OPERATIONS.md](docs/OPERATIONS.md#1-environment) and `.env.example`. Everything else is set in the CRM under **Settings** (needs `settings:manage`):

| Settings section | What it controls | Read |
|---|---|---|
| Regional format, Markets, Appearance | Currency, tax, dates, markets, logo and themes | [CATALOG.md](docs/CATALOG.md) |
| Customers and segments, Bill cycles | Customer fields and segments, the 28 bill cycles | [CUSTOMERS.md](docs/CUSTOMERS.md) |
| Offer types, Fulfilment options, Service types | What an offer can be and how it is fulfilled and provisioned | [CATALOG.md](docs/CATALOG.md) |
| Cancellation | Cooling-off and cancellation terms per order part | [ORDERS.md](docs/ORDERS.md) |
| Early termination | Rules and formulas for the charge when a contract ends early | [LIFECYCLE.md](docs/LIFECYCLE.md) |
| Device financing | Instalments over the contract, credit-check bands, fallback | [FINANCING.md](docs/FINANCING.md) |
| Dunning rules | Ladders, late fees, QR links, arrangements, collections | [DUNNING.md](docs/DUNNING.md) |
| Cases, Donor operators, Numbers & SIMs | SLA matrix and taxonomy, port-in operators, number pools and VIP tiers | [CASES.md](docs/CASES.md), [NUMBERING.md](docs/NUMBERING.md) |

Everything about outside systems is under the **Integration** menu (next to Settings): *Connections* shows each connection and whether it works, and *Integration hub* holds OAuth clients, API keys, rate limits, webhooks, TMF 688 subscriptions, field-service, network, finance and credit-bureau endpoints, and event topics ([INTEGRATION_API.md](docs/INTEGRATION_API.md)).

## Documentation

- [Store-front, KYC and online payments](docs/STOREFRONT.md): deploying the store-front, the store API, KYC, Stripe, assisted sales
- [Product catalog](docs/CATALOG.md): the five-level hierarchy, offer line items, dependencies, bulk offer import, offer type switches and service types, markets
- [Dunning and collections](docs/DUNNING.md): configurable rule-based ladders per market and customer type, late fees, QR payment links (PromptPay, PayNow, DuitNow, QRIS, QR Ph), exclusions, partial payments, payment arrangements, collection agency placements, Southeast Asia starter rules
- [Device financing](docs/FINANCING.md): a device on a contract paid evenly over the contract with the plan bill, credit check through an integration (score bands or the bureau's upfront amount), consent, fallback
- [Service lifecycle](docs/LIFECYCLE.md): voluntary suspension, credit-limit bars, the dunning ladder, termination and the early-termination charge (rules and formulas), port-out
- [Finance: sub-ledger, SAP journals, reconciliation](docs/FINANCE.md): events into an immutable ledger, posting rules to SAP accounts, IDoc/flat/JSON/CSV export, daily close, reconciliation
- [Cases: classification, SLA, lifecycle, interactions, watchdog, refunds, incidents](docs/CASES.md): the three-level case taxonomy, the SLA matrix, the case state machine with guards, the interaction registry, the SLA watchdog (sweep and Temporal workflow), refund approval by amount, master network incidents, field-service visits with a signed callback, and TM Forum views
- [Billing: bill runs, governance, simulator, templates, print house](docs/BILLING.md): mock, review, exclusions and approval for every cycle, anomalies, selective and retry runs, dual control, the Temporal workflow; forecast bills, quote ending a service, preview a plan change; the bill template designer, legacy converter, PDF renderer and print-house package
- [Data migration](docs/MIGRATION.md): back up and move data: streaming exports with masking, templates for every data set
- [Bulk import and export](docs/BULK_IMPORT.md): dealers, agents and stores as spreadsheets: templates, current data, check then load
- [Charging system (OCS)](docs/OCS.md): per-vendor connectors that create subscribers and plans in the OCS, with retries
- [Integrations](docs/INTEGRATIONS.md): every external system Meridian connects to, grouped by function, with status
- [Integration hub and northbound API](docs/INTEGRATION_API.md): OAuth 2.0 clients and API keys, scopes, per-channel rate limits, idempotency, TM Forum errors and TMF 688 subscriptions, webhooks, and the settings for field service, core network, finance and events
- [Dealer and agent commission](docs/COMMISSION.md): channel hierarchy, plans with volume bands, claw-backs, statements, payouts, GL posting
- [Numbers, SIM cards and order numbers](docs/NUMBERING.md): `YYYYMMDD-NNNNN` order numbers, SIM and number choice, VIP tiers, pool loading, reservations, recycling
- [Group plans, family lines and port-in](docs/FAMILY_PLANS.md): group plans, how a group is created (order or plan change), member limits, bringing numbers from other operators
- [Orders: fulfilment, cancellation and returns](docs/ORDERS.md): fulfilment groups, points of no return, refunds, instalments, bundles
- [Customers, segments and groups](docs/CUSTOMERS.md): customer → account → service, segments, moving customers, groups with principal and supplementary services
- [Working with millions of records](docs/SCALE.md): paging, search and indexes behind every list
- [Operating Meridian](docs/OPERATIONS.md): environment variables, runbook, payments, scale, upgrades, loading stock, warehouses and stock transfers
- [Security model](docs/SECURITY.md): what is protected, and what still needs work
- [Roles and permissions](docs/ROLES.md): the default roles (generated from the code that enforces them), and how to change them or add your own
- [Architecture](docs/ARCHITECTURE.md)

## Status

Production-oriented, not feature-complete. **Not included in this release:** payment gateways other than Stripe, usage rating and charging (the Go gateway is a skeleton; the charging system reports unbilled usage through the credit-check and closing-bill APIs), MFA/SSO, customer login to the store-front (existing customers buying online), a
visual order-workflow designer (the Temporal service holds the order and dunning workflows but is not wired to the app), delivery of notifications and network instructions (they are queued in an outbox for adapters; nothing sends SMS/e-mail or talks to PCRF/HLR yet), screens for the lifecycle settings, GraphQL. See
[Security](docs/SECURITY.md#not-covered-yet-plan-for-these-before-regulated-go-live) before handling real customer data.
