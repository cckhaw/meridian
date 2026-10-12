# Meridian

CRM, order management, billing and finance for a telecom operator: customers and hierarchies, product catalog, orders and fulfilment,
subscription lifecycle, bill runs and invoices, double-entry ledger with SAP export, cases, inventory, role-based access.

Sign-in is required. Staff and customers see only the modules and records their **role** allows ([docs/ROLES.md](docs/ROLES.md)).

## Run it locally

```bash
pnpm install
pnpm --filter @meridian/web dev      # http://localhost:3000
```

Sign in as `admin` / `local-dev-only-Passphrase-1` (from `apps/web/.env.development`, development only). With no `DATABASE_URL` it runs an
embedded PostgreSQL seeded with sample data. Then create staff under **Users & roles** and sign in as them to see each role’s view.

```bash
pnpm typecheck && pnpm test          # 77 tests; set TEST_DATABASE_URL=postgres://.../postgres to run the core suite on real Postgres
```

## Run it in production

Set `DATABASE_URL`, `MERIDIAN_SUPERUSER_USERNAME`, `MERIDIAN_SUPERUSER_PASSWORD` and `MERIDIAN_ID_PEPPER`, deploy, and follow the
[day-one runbook](docs/OPERATIONS.md). Meridian refuses to serve traffic if these are missing or weak.

## Documentation

- [Operating Meridian](docs/OPERATIONS.md): environment, runbook, payments, scale, upgrades
- [Security model](docs/SECURITY.md): what is protected, and what still needs work
- [Roles and permissions](docs/ROLES.md): generated from the code that enforces them
- [Architecture](docs/ARCHITECTURE.md)

## Status

Production-oriented, not feature-complete. **Not included in this release:** a payment gateway (staff-recorded payments and a signed webhook
are provided), usage rating and charging (the Go gateway is a skeleton), MFA/SSO, customer self-registration, returns and exchanges, a
visual order-workflow designer (the Temporal service exists but is not wired to the app), notifications, GraphQL. See
[Security](docs/SECURITY.md#not-covered-yet-plan-for-these-before-regulated-go-live) before handling real customer data.
