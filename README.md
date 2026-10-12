# Meridian

Telco CRM, order management and billing for large subscriber bases (ASEAN). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it (no infrastructure needed)

```bash
pnpm install
pnpm --filter @meridian/web dev     # http://localhost:3000
```

With no `DATABASE_URL` it starts an embedded PostgreSQL (PGlite) and seeds demo customers, orders, invoices and a ledger,
so every screen has data. Data is in-memory unless you set `MERIDIAN_DATA_DIR`.

For a real database, copy `.env.example`, set `DATABASE_URL` (PostgreSQL 14+; migrations run on start) and the app uses it.

```bash
pnpm typecheck && pnpm test         # 43 tests; add TEST_DATABASE_URL=postgres://.../postgres to run them on real Postgres
```

## What works today

| Area | Capability |
|---|---|
| Customer 360 | Search, hierarchy (enterprise departments, family groups), accounts, services, orders, invoices, cases, next-best-action |
| Catalog | Network → category → group → offer; SIM-only, SIM + device (12/24/36 mo), wearables, VAS, OTT subscriptions, physical goods, IoT; ETC quotes |
| Orders | Self-serve, retail, quick-sale, telesales, dealer, call centre; payment (card, cash, QR, instalments); stock reservation; fibre installation; shipping; point-of-no-return cancellation; commission |
| Lifecycle | Suspend/resume, SIM and number change, ownership transfer, termination with ETC, MNP port-in (order) and port-out |
| Billing | Daily and 1st–28th cycles, pro-ration, tax, instalments, partial payments, credit notes and refunds, dunning (reminder, suspend, review), printable invoices |
| Finance | Balanced double-entry ledger, SAP-style CSV export in batches, reconciliation (ledger vs invoices vs payments), trial balance |
| Ops | Inventory, cases, audit log, commission report |

## Not built yet

Authentication and per-persona permissions (the persona switcher only changes navigation, **do not expose this to the internet as is**),
a real payment gateway (simulated), usage rating/charging (the Go gateway is a skeleton), Kafka event publishing,
Temporal-backed orchestration in the app (orders run in-process; the Temporal service remains separate),
reverse logistics (returns/exchanges), WYSIWYG invoice designer (invoices are print-styled HTML), email/SMS notifications,
GraphQL, and multi-currency formatting beyond 2-decimal currencies.
