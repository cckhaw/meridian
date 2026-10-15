# Meridian

CRM, order management, billing and finance for a telecom operator: customers and hierarchies, product catalog, orders and fulfilment,
subscription lifecycle (suspension, dunning, termination, port-out), bill runs and invoices, double-entry ledger with SAP export, cases, inventory with warehouses and write-offs, role-based access with roles you define,
an editable product hierarchy with dependencies between products, one-market or multi-market operation, regional/branding settings, and an independently hosted **self-service store-front**
with KYC onboarding, Stripe payments and assisted in-store sales.

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
pnpm typecheck && pnpm test          # 506 tests; set TEST_DATABASE_URL=postgres://.../postgres to run the core suite on real Postgres
```

## Run it in production

Set `DATABASE_URL`, `MERIDIAN_SUPERUSER_USERNAME`, `MERIDIAN_SUPERUSER_PASSWORD` and `MERIDIAN_ID_PEPPER`, deploy, and follow the
[day-one runbook](docs/OPERATIONS.md). Meridian refuses to serve traffic if these are missing or weak.

## Documentation

- [Store-front, KYC and online payments](docs/STOREFRONT.md): deploying the store-front, the store API, KYC, Stripe, assisted sales
- [Product catalog](docs/CATALOG.md): the five-level hierarchy, offer line items, dependencies, bulk offer import, offer type switches and service types, markets
- [Service lifecycle](docs/LIFECYCLE.md): voluntary suspension, credit-limit bars, the dunning ladder, termination and ETC, port-out
- [Finance: sub-ledger, SAP journals, reconciliation](docs/FINANCE.md): events into an immutable ledger, posting rules to SAP accounts, IDoc/flat/JSON/CSV export, daily close, reconciliation
- [Billing: bill runs, governance, simulator](docs/BILLING.md): mock, review, exclusions and approval for every cycle, anomalies, selective and retry runs, dual control, the Temporal workflow; forecast bills, quote ending a service, preview a plan change
- [Data migration](docs/MIGRATION.md): back up and move data: streaming exports with masking, templates for every data set
- [Bulk import and export](docs/BULK_IMPORT.md): dealers, agents and stores as spreadsheets: templates, current data, check then load
- [Charging system (OCS)](docs/OCS.md): per-vendor connectors that create subscribers and plans in the OCS, with retries
- [Integrations](docs/INTEGRATIONS.md): every external system Meridian connects to, grouped by function, with status
- [Dealer and agent commission](docs/COMMISSION.md): channel hierarchy, plans with volume bands, claw-backs, statements, payouts, GL posting
- [Numbers, SIM cards and order numbers](docs/NUMBERING.md): `YYYYMMDD-NNNNN` order numbers, SIM and number choice, VIP tiers, pool loading, reservations, recycling
- [Group plans, family lines and port-in](docs/FAMILY_PLANS.md): group plans, how a group is created (order or plan change), member limits, bringing numbers from other operators
- [Orders: fulfilment, cancellation and returns](docs/ORDERS.md): fulfilment groups, points of no return, refunds, instalments, bundles
- [Customers, segments and groups](docs/CUSTOMERS.md): customer → account → service, segments, moving customers, groups with principal and supplementary services
- [Working with millions of records](docs/SCALE.md): paging, search and indexes behind every list
- [Operating Meridian](docs/OPERATIONS.md): environment, runbook, payments, scale, upgrades
- [Security model](docs/SECURITY.md): what is protected, and what still needs work
- [Roles and permissions](docs/ROLES.md): the default roles (generated from the code that enforces them), and how to change them or add your own
- [Architecture](docs/ARCHITECTURE.md)

## Status

Production-oriented, not feature-complete. **Not included in this release:** payment gateways other than Stripe, usage rating and charging (the Go gateway is a skeleton; the charging system reports unbilled usage through the credit-check and closing-bill APIs), MFA/SSO, customer login to the store-front (existing customers buying online), a
visual order-workflow designer (the Temporal service holds the order and dunning workflows but is not wired to the app), delivery of notifications and network instructions (they are queued in an outbox for adapters; nothing sends SMS/e-mail or talks to PCRF/HLR yet), screens for the lifecycle settings, GraphQL. See
[Security](docs/SECURITY.md#not-covered-yet-plan-for-these-before-regulated-go-live) before handling real customer data.
